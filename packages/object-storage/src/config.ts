import { z } from 'zod';

export const storageConfigFields = {
  STORAGE_PROVIDER: z.enum(['s3']).default('s3'),
  STORAGE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  STORAGE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  STORAGE_WRITE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
};

export type StorageConfig = z.infer<z.ZodObject<typeof storageConfigFields>>;
