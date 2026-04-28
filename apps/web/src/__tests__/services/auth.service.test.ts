import { describe, it, expect, beforeEach } from 'vitest';
import { authService } from '../../services/auth.service';

describe('authService', () => {
  beforeEach(async () => {
    await authService.logout();
  });

  it('rejects empty org', async () => {
    await expect(authService.login({ org: '', password: 'pass1234' })).rejects.toThrow(
      'Invalid credentials',
    );
  });

  it('rejects short password', async () => {
    await expect(authService.login({ org: 'TRRAIN', password: '1' })).rejects.toThrow(
      'Invalid credentials',
    );
  });

  it('returns user on valid credentials', async () => {
    const user = await authService.login({ org: 'TRRAIN', password: 'pass1234' });
    expect(user).toMatchObject({ org: 'TRRAIN', name: 'R. Krishnan' });
  });

  it('current returns user after login, null after logout', async () => {
    await authService.login({ org: 'TRRAIN', password: 'pass1234' });
    expect(await authService.current()).not.toBeNull();
    await authService.logout();
    expect(await authService.current()).toBeNull();
  });
});
