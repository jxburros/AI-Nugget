"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.estimatedUsage = estimatedUsage;
exports.mergeUsage = mergeUsage;
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function estimatedUsage(inputText, outputText) {
    return {
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(outputText),
        estimated: true,
    };
}
function mergeUsage(a, b) {
    return {
        inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
        outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
        estimated: a.estimated || b.estimated,
    };
}
