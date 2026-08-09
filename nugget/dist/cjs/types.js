"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelRef = modelRef;
function modelRef(source, model) {
    return `${source.provider}/${model}`;
}
