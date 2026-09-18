'use client';

import type { DragEvent, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface DropzoneProps {
  onFiles?: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}

export function Dropzone({ onFiles, className, children }: DropzoneProps) {
  // `onDragOver` must preventDefault or the browser never fires `drop`.
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    onFiles?.(files);
  };

  return (
    <div
      className={cn('dropzone p-10 text-center', className)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}
