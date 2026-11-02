import { ApplicationRepeatedEventRecorderService } from 'src/engine/core-modules/event-logs/emit/application-repeated-event-recorder.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UsageRecorderService } from 'src/engine/core-modules/usage/services/usage-recorder.service';

import { createApp } from './create-app';

const bootstrap = async () => {
  const app = await createApp();
  const twentyConfigService = app.get(TwentyConfigService);

  const usageRecorder = app.get(UsageRecorderService);
  const applicationRepeatedEventRecorder = app.get(
    ApplicationRepeatedEventRecorderService,
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void Promise.allSettled([
        usageRecorder.flushAndStop(),
        applicationRepeatedEventRecorder.flushAndStop(),
      ]).finally(() => process.exit(0));
    });
  }

  const keepAliveTimeout = twentyConfigService.get(
    'SERVER_KEEP_ALIVE_TIMEOUT_MS',
  );
  const httpServer = app.getHttpServer();

  httpServer.keepAliveTimeout = keepAliveTimeout;
  httpServer.headersTimeout = keepAliveTimeout + 1000;

  await app.listen(twentyConfigService.get('NODE_PORT'));
};

void bootstrap();
