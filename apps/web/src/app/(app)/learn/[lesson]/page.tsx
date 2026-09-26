import { notFound } from 'next/navigation';

import { Lesson } from '@/components/novice/Learn';
import { isLesson } from '@/lib/novice/learn';

export const metadata = { title: 'Lesson' };

export default async function Page({ params }: { params: Promise<{ lesson: string }> }) {
  const { lesson } = await params;
  if (!isLesson(lesson)) notFound();
  return <Lesson id={lesson} />;
}
