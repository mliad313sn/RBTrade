import { Suspense } from 'react';

import { AuthFlow } from '@/components/auth/AuthFlow';

export const metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <Suspense>
      <AuthFlow mode="signup" />
    </Suspense>
  );
}
