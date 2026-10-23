import { Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsClient {
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  async check(queueUrl: string): Promise<void> {
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  }

  async queueDepth(queueUrl: string): Promise<number> {
    const result = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  }

  async publish(queueUrl: string, body: string, groupId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: JSON.parse(body).eventId,
    }));
  }

  async sendToDlq(queueUrl: string, body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }));
  }

  async changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  }

  async receive(queueUrl: string) {
    const result = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }));
    return result.Messages ?? [];
  }

  async acknowledge(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }
}
