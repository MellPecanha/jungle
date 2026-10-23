import { IntegrationEvent, type IntegrationEventProps } from '../../common/events/integration-event.js';

type WagerEventData = Record<string, unknown>;

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static create(props: IntegrationEventProps<WagerEventData>): WagerTransactionProcessed { return new WagerTransactionProcessed(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static create(props: IntegrationEventProps<WagerEventData>): WagerTransactionRejected { return new WagerTransactionRejected(props); }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static create(props: IntegrationEventProps<WagerEventData>): WagerTransactionPendingReference { return new WagerTransactionPendingReference(props); }
}
