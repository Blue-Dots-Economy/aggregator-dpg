import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth-context';
import { ShellLayout } from './components/shell/ShellLayout';
import { ProtectedRoute } from './routes/protected';
import { LoginRoute } from './routes/login';
import { BlueDotsRoute } from './routes/blue-dots';
import { OnboardingRoute } from './routes/onboarding';
import { ProfileRoute } from './routes/profile';

function RootRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? '/blue-dots' : '/login'} replace />;
}

function LoginRedirect() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) {
    return <Navigate to="/blue-dots" replace />;
  }
  return <LoginRoute />;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<LoginRedirect />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<ShellLayout />}>
            <Route path="/blue-dots" element={<BlueDotsRoute />} />
            <Route path="/onboarding" element={<OnboardingRoute />} />
            <Route path="/profile" element={<ProfileRoute />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
