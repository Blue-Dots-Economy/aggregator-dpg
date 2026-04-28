import type { User } from '../types';

export interface AuthService {
  login(input: { org: string; password: string }): Promise<User>;
  logout(): Promise<void>;
  current(): Promise<User | null>;
}

class MockAuthService implements AuthService {
  private user: User | null = null;

  async login(input: { org: string; password: string }): Promise<User> {
    if (!input.org || input.password.length < 4) {
      throw new Error('Invalid credentials');
    }
    this.user = {
      id: 'u-trrain-001',
      name: 'R. Krishnan',
      org: input.org,
    };
    return this.user;
  }

  async logout(): Promise<void> {
    this.user = null;
  }

  async current(): Promise<User | null> {
    return this.user;
  }
}

export const authService: AuthService = new MockAuthService();
