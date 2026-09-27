import { notFound } from 'next/navigation';

import { Lesson } from '@/components/novice/Learn';
import { isLesson } from '@/lib/novice/learn';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('meta.lesson');
}

export default async function Page({ params }: { params: Promise<{ lesson: string }> }) {
  const { lesson } = await params;
  if (!isLesson(lesson)) notFound();
  return <Lesson id={lesson} />;
}
