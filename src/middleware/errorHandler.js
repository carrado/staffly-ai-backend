// Copied from velte-backend/src/middleware/errorHandler.js verbatim — kept
// in sync by hand, same as the other cross-repo duplicated files (see this
// repo's README).

/**
 * Operational error class — errors we expect and handle gracefully.
 * Non-operational errors (programming bugs, DB crashes) bubble up differently.
 */
export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global Express error handler.
 * Must be registered LAST with app.use().
 */
export function errorHandler(err, req, res, _next) {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {}).join(", ");
    err = new AppError(`Duplicate value for field: ${field}`, 409);
  }

  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    err = new AppError(messages.join(". "), 400);
  }

  if (err.name === "CastError") {
    err = new AppError(`Invalid value for field: ${err.path}`, 400);
  }

  const isDev = process.env.NODE_ENV === "development";

  if (isDev) {
    return res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: err.message,
      stack: err.stack,
      err,
    });
  }

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: err.message,
    });
  }

  console.error("💥 UNHANDLED ERROR:", err);
  return res.status(500).json({
    success: false,
    status: "error",
    message: "Something went wrong. Please try again later.",
  });
}

/**
 * 404 handler — register before errorHandler.
 */
export function notFound(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}
