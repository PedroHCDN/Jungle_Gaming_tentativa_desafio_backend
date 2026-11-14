import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';
const maxReceiveCount = process.env.SQS_MAX_RECEIVE_COUNT ?? '5';

const MAIN_QUEUE = 'wager-transactions.fifo';
const DLQ = 'wager-transactions-dlq.fifo';

const client = new SQSClient({
  endpoint,
  region,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function waitForSqs(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await client.send(new ListQueuesCommand({}));
      return;
    } catch {
      console.log(`SQS ainda indisponível (${i}/${attempts})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`SQS não respondeu em ${endpoint}`);
}

async function main(): Promise<void> {
  await waitForSqs();

  // A DLQ nasce primeiro, porque a fila principal precisa do ARN dela.
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: DLQ,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        MessageRetentionPeriod: '1209600', // 14 dias
      },
    }),
  );
  if (!dlq.QueueUrl) throw new Error('DLQ criada sem QueueUrl');

  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ sem QueueArn');

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: MAIN_QUEUE,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount,
        }),
      },
    }),
  );

  console.log(`Fila principal: ${main.QueueUrl}`);
  console.log(`DLQ:            ${dlq.QueueUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
