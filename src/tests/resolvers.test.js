const { levenshteinDistance } = require('../services/agent/resolvers');
const { setPendingAction, getPendingAction, clearPendingAction } = require('../services/agent/confirmation');

describe('Resolvers & Utilities Unit Tests', () => {
  describe('Levenshtein Distance', () => {
    test('exact matches return distance 0', () => {
      expect(levenshteinDistance('arangettram', 'arangettram')).toBe(0);
      expect(levenshteinDistance('gala', 'gala')).toBe(0);
    });

    test('typos are calculated accurately', () => {
      expect(levenshteinDistance('arangetram', 'arangettram')).toBe(1);
      expect(levenshteinDistance('arangettrm', 'arangettram')).toBe(1);
      expect(levenshteinDistance('arinjetram', 'arangettram')).toBe(3);
    });

    test('case sensitivity handled correctly', () => {
      expect(levenshteinDistance('Gala'.toLowerCase(), 'gala'.toLowerCase())).toBe(0);
    });
  });

  describe('Confirmation State Machine', () => {
    test('sets, gets, and clears pending actions per user', () => {
      const mockUserId = 'user-123';
      const mockAction = { toolName: 'create_event', args: { title: 'Test Gala' } };

      setPendingAction(mockUserId, mockAction);
      const pending = getPendingAction(mockUserId);
      expect(pending).not.toBeNull();
      expect(pending.toolName).toBe(mockAction.toolName);
      expect(pending.args).toEqual(mockAction.args);
      expect(pending.expiresAt).toBeGreaterThan(Date.now());

      clearPendingAction(mockUserId);
      expect(getPendingAction(mockUserId)).toBeNull();
    });
  });
});
