/**
 * Result 类型 - 错误处理，不使用 throw
 */

/** 成功结果 */
export interface Ok<T> {
  ok: true;
  value: T;
}

/** 错误结果 */
export interface Err {
  ok: false;
  error: AppError;
}

/** Result 类型 */
export type Result<T, _E = AppError> = Ok<T> | Err;

/** 应用错误 */
export interface AppError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

/** 错误码枚举 */
export enum ErrorCode {
  // 进程相关
  ProcessSpawnFailed = "PROCESS_SPAWN_FAILED",
  ProcessExited = "PROCESS_EXITED",
  ProcessCrashed = "PROCESS_CRASHED",
  IoError = "IO_ERROR",

  // 设备相关
  DeviceNotFound = "DEVICE_NOT_FOUND",
  DevicePermissionDenied = "DEVICE_PERMISSION_DENIED",
  DeviceReadFailed = "DEVICE_READ_FAILED",

  // 通信相关
  MessageEncodeFailed = "MESSAGE_ENCODE_FAILED",
  MessageDecodeFailed = "MESSAGE_DECODE_FAILED",
  InvalidResponse = "INVALID_RESPONSE",

  // 未知
  Unknown = "UNKNOWN",
}

/** 创建成功结果 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** 创建成功结果（无值） */
export function okVoid(): Ok<void> {
  return { ok: true, value: undefined };
}

/** 创建错误结果 */
export function err(code: ErrorCode, message: string, detail?: unknown): Err {
  return {
    ok: false,
    error: { code, message, detail },
  };
}

/** 从未知错误创建错误结果 */
export function errFromUnknown(e: unknown): Err {
  if (e instanceof Error) {
    return err(ErrorCode.Unknown, e.message, e);
  }
  return err(ErrorCode.Unknown, String(e), e);
}
