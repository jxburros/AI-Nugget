export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export function estimatedUsage(inputText, outputText) {
    return {
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(outputText),
        estimated: true,
    };
}
export function mergeUsage(a, b) {
    return {
        inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
        outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
        estimated: a.estimated || b.estimated,
    };
}
//# sourceMappingURL=tokens.js.map