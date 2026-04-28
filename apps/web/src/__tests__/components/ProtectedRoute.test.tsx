import { describe, it, expect } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { ProtectedRoute } from '../../routes/protected';
import { renderWithProviders } from '../test-utils';

function Tree() {
  return (
    <Routes>
      <Route path="/login" element={<div>login-screen</div>} />
      <Route element={<ProtectedRoute />}>
        <Route path="/secret" element={<div>secret-content</div>} />
      </Route>
    </Routes>
  );
}

describe('<ProtectedRoute />', () => {
  it('redirects unauthenticated users to /login', () => {
    renderWithProviders(<Tree />, { initialEntries: ['/secret'] });
    expect(screen.getByText('login-screen')).toBeInTheDocument();
    expect(screen.queryByText('secret-content')).not.toBeInTheDocument();
  });
});
