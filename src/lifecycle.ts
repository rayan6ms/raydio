export interface StoppableService {
  stop(): Promise<void>;
}

export async function stopServicesInOrder(services: readonly StoppableService[]): Promise<void> {
  const errors: unknown[] = [];

  for (const service of services) {
    try {
      await service.stop();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more services failed to stop");
  }
}
