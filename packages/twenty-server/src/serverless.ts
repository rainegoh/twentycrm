import { type NestExpressApplication } from '@nestjs/platform-express';

import { type Request, type Response } from 'express';

import { createApp } from './create-app';

let appPromise: Promise<NestExpressApplication> | undefined;

// Vercel reuses warm function instances: boot Nest once, then replay requests through Express.
const getApp = (): Promise<NestExpressApplication> => {
  appPromise ??= createApp().then(async (app) => {
    await app.init();

    return app;
  });

  return appPromise;
};

export const serverlessHandler = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const app = await getApp();

  app.getHttpAdapter().getInstance()(request, response);
};
