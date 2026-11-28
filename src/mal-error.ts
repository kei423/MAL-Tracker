export class MalError extends Error {
    constructor(message: string, public retryable = true, public requiresAuth = false, public retryAfter = 0) {
        super(message);
    }
}
