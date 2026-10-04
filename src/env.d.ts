// Timers exist in both React Native and Node; declared here so the core does not depend on DOM or Node typings.
declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
