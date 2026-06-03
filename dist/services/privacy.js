export function stripPrivateContent(content) {
    return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}
export function isFullyPrivate(content) {
    const stripped = stripPrivateContent(content).trim();
    return stripped === "[REDACTED]" || stripped === "";
}
