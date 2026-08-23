/**
 * @file confirmation.js
 * @description In-memory confirmation manager with 5-minute expiration
 */

const pendingActions = new Map();

/**
 * Store a pending action waiting for user confirmation (5 minutes TTL).
 * @param {string} userId - ID of the user
 * @param {object} actionData - Tool name, args, and execution context
 */
function setPendingAction(userId, actionData) {
  pendingActions.set(userId, {
    ...actionData,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

/**
 * Retrieve a pending action for a user if still valid.
 * @param {string} userId - ID of the user
 * @returns {object|null}
 */
function getPendingAction(userId) {
  const pending = pendingActions.get(userId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    pendingActions.delete(userId);
    return null;
  }
  return pending;
}

/**
 * Clear a pending action for a user.
 * @param {string} userId - ID of the user
 */
function clearPendingAction(userId) {
  pendingActions.delete(userId);
}

module.exports = {
  setPendingAction,
  getPendingAction,
  clearPendingAction,
};
