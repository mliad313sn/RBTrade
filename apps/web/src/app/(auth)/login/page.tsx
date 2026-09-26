import { Suspense } from 'react';

import { AuthFlow } from '@/components/auth/AuthFlow';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <Suspense>
      <AuthFlow mode="login" />
    </Suspense>
  );
}
