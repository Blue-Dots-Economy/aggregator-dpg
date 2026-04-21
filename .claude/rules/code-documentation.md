# Rule: Code Documentation

Every public class, method, and function must have a TSDoc comment. Private helpers (`_` prefix or unexported) should have one if the logic is non-obvious.

**Format:** Use TSDoc.

```typescript
/**
 * Assembles the full API prompt from NLU results and session history.
 *
 * @param request - Contains intent, entities, session history, and raw input.
 * @returns PromptResponse with the assembled system prompt and user message.
 * @throws {ValueError} If request.intent is null or empty.
 * @throws {KnowledgeEngineError} If RAG retrieval fails after retries.
 */
assemblePrompt(request: PromptRequest): Promise<PromptResponse> {
```

**Rules:**
- The first line is a single-sentence summary ending with a period.
- Document all parameters (`@param`), return values (`@returns`), and thrown exceptions (`@throws`).
- Do not restate the function name or describe *how* it works — describe *what* it does and *why* the caller needs it.
- Module-level file comments must state the module's role within the DPG framework and which package it belongs to.
