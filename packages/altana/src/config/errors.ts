/**
 * Configuration failures are always fatal at startup.
 *
 * They carry a distinct `name` and the offending variable so an operator reads
 * *which* value is wrong from the first line of the crash, rather than
 * discovering it later as an opaque validation revert at the first payment.
 * No error message ever contains the value of a secret.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A required environment variable is unset or empty. */
export class MissingConfigError extends ConfigError {
  readonly variable: string;

  constructor(variable: string, purpose: string) {
    super(`${variable} is required (${purpose}) but is unset or empty`);
    this.name = "MissingConfigError";
    this.variable = variable;
  }
}

/** An environment variable is set but cannot be read as the type it must be. */
export class InvalidConfigError extends ConfigError {
  readonly variable: string;
  readonly reason: string;

  constructor(variable: string, reason: string) {
    super(`${variable} is invalid: ${reason}`);
    this.name = "InvalidConfigError";
    this.variable = variable;
    this.reason = reason;
  }
}
