import { GoogleGenAI, Type } from "@google/genai";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors that another API key may fix (bad key, permission, quota).
const isKeyError = error => [401, 403, 429].includes(Number(error?.status));

// Problems with the model's output; switching keys will not help.
class ContentError extends Error {}

const normalize = value =>
    String(value)
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();

export class GeminiAnswerFallback {
    constructor({
        keysPath = "./gemini-keys.json",
        answersPath = "./answers.json",
        model = "gemini-3.5-flash-lite",
        batchSize = 10,
        maxAttemptsPerKey = 2
    } = {}) {
        this.keysPath = path.resolve(keysPath);
        this.answersPath = path.resolve(answersPath);
        this.model = model;
        this.batchSize = batchSize;
        this.maxAttemptsPerKey = maxAttemptsPerKey;

        this.nextKeyIndex = 0;
        this.writeQueue = Promise.resolve();
    }

    async loadKeys() {
        const config = JSON.parse(
            await readFile(this.keysPath, "utf8")
        );

        if (!config || typeof config !== "object" || !Array.isArray(config.keys)) {
            throw new Error("gemini-keys.json must contain a keys array.");
        }

        const keys = config.keys
            .filter(key => typeof key === "string")
            .map(key => key.trim())
            .filter(Boolean);

        if (keys.length === 0) {
            throw new Error("No Gemini API keys configured.");
        }

        return keys;
    }

    async saveAnswers(answersDb) {
        // Recover from an earlier failed write so one error does not make
        // every later save fail too.
        const write = this.writeQueue.catch(() => {}).then(async () => {
            const tempPath = `${this.answersPath}.tmp`;

            await writeFile(
                tempPath,
                JSON.stringify(answersDb, null, 2) + "\n",
                "utf8"
            );

            await rename(tempPath, this.answersPath);
        });

        this.writeQueue = write;
        return write;
    }

    async generateBatch(category, existingAnswers, excludedAnswers) {
        const keys = await this.loadKeys();
        const existingSet = new Set([
            ...existingAnswers.map(normalize),
            ...[...excludedAnswers].map(normalize)
        ]);

        let lastError;
        let contentFailures = 0;

        for (let keyAttempt = 0; keyAttempt < keys.length; keyAttempt++) {
            const keyIndex = (this.nextKeyIndex + keyAttempt) % keys.length;
            const apiKey = keys[keyIndex];

            for (let attempt = 0; attempt < this.maxAttemptsPerKey; attempt++) {
                try {
                    const ai = new GoogleGenAI({ apiKey });

                    const response = await ai.models.generateContent({
                        model: this.model,
                        contents: `
Generate exactly ${this.batchSize} distinct, valid answers for this game category:

"${category}"

Rules:
- Return answers that directly satisfy the category.
- Prefer well-known, unambiguous answers.
- Every answer must be in English.
- Each answer must be no longer than 60 characters.
- Do not include numbering, explanations, or quotation marks.
- Do not repeat answers.
- Do not return any of these existing or already-used answers:
${[...existingSet].join("\n")}

Return only the requested JSON array.
                        `.trim(),
                        config: {
                            responseMimeType: "application/json",
                            responseSchema: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.STRING
                                }
                            }
                        }
                    });

                    let parsed;

                    try {
                        parsed = JSON.parse(response.text ?? "[]");
                    } catch {
                        throw new ContentError("Gemini returned invalid JSON.");
                    }

                    if (!Array.isArray(parsed)) {
                        throw new ContentError("Gemini returned something other than an array.");
                    }

                    const generated = [];
                    const batchSet = new Set(existingSet);

                    for (const value of parsed) {
                        if (typeof value !== "string") continue;

                        const answer = value
                            .replace(/\s+/g, " ")
                            .trim();

                        const normalized = normalize(answer);

                        if (
                            !answer ||
                            answer.length > 60 ||
                            batchSet.has(normalized)
                        ) {
                            continue;
                        }

                        batchSet.add(normalized);
                        generated.push(answer);
                    }

                    if (generated.length === 0) {
                        throw new ContentError("Gemini did not return any usable new answers.");
                    }

                    this.nextKeyIndex = (keyIndex + 1) % keys.length;
                    return generated;

                } catch (error) {
                    lastError = error;

                    if (error instanceof ContentError) {
                        // Retry the content a few times in total, not per key.
                        contentFailures++;
                        if (contentFailures >= this.maxAttemptsPerKey) {
                            throw new Error(
                                `Gemini failed to generate answers for "${category}": ${error.message}`
                            );
                        }
                        continue;
                    }

                    if (isKeyError(error)) {
                        // This key is unusable right now; try the next one.
                        break;
                    }

                    // Network or server error: back off, then retry.
                    await sleep(500 * (attempt + 1));
                }
            }
        }

        throw new Error(
            `Gemini failed to generate answers for "${category}": ${lastError?.message ?? "Unknown error"}`
        );
    }

    async getAnswers(category, answersDb, excludedAnswers = new Set()) {
        if (typeof category !== "string" || !category.trim()) {
            throw new TypeError("A valid category is required.");
        }

        if (!answersDb || typeof answersDb !== "object") {
            throw new TypeError("Invalid answers database.");
        }

        if (!Array.isArray(answersDb[category])) {
            answersDb[category] = [];
        }

        const generated = await this.generateBatch(
            category,
            answersDb[category],
            excludedAnswers
        );

        answersDb[category].push(...generated);

        await this.saveAnswers(answersDb);

        return generated;
    }
}