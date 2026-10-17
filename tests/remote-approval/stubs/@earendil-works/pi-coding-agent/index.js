// Faithful to the real implementation in core/extensions/types.js:
//   export function isToolCallEventType(toolName, event) { return event.toolName === toolName; }
exports.isToolCallEventType = (toolName, event) => event.toolName === toolName;
