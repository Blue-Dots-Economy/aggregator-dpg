import { useState, type DragEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface DropzoneProps {
  onFiles?: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}

export function Dropzone({ onFiles, className, children }: DropzoneProps) {
  const [_hover, setHover] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(true);
  };
  const handleDragLeave = () => setHover(false);
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    const files = Array.from(e.dataTransfer.files);
    onFiles?.(files);
  };

  return (
    <div
      className={cn('dropzone p-10 text-center', className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}
