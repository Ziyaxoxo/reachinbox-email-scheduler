import { Client } from "@elastic/elasticsearch";
import { env } from "../../config/env.js";
import { logger } from "../../observability/logger.js";

export const esClient = new Client({
  node: env.ELASTICSEARCH_URL,
  requestTimeout: 5000,
  pingTimeout: 3000,
});

const INDEX_NAME = "reachinbox-emails";

const INDEX_MAPPING = {
  mappings: {
    properties: {
      scheduleId: { type: "keyword" },
      ownerId: { type: "keyword" },
      recipientId: { type: "keyword" },
      normalizedEmail: { type: "keyword" },
      subject: { type: "text", analyzer: "standard" },
      status: { type: "keyword" },
      scheduledAt: { type: "date" },
      sentAt: { type: "date" },
      attempt: { type: "integer" },
      providerId: { type: "keyword" },
      failureCode: { type: "keyword" },
      createdAt: { type: "date" },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
};

export async function ensureIndex(): Promise<void> {
  try {
    const exists = await esClient.indices.exists({ index: INDEX_NAME });
    if (!exists) {
      await esClient.indices.create({
        index: INDEX_NAME,
        ...INDEX_MAPPING,
      });
      logger.info({ index: INDEX_NAME }, "Created Elasticsearch index");
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to ensure Elasticsearch index");
  }
}

export async function indexEmailRecord(record: {
  recipientId: string;
  scheduleId: string;
  ownerId: string;
  normalizedEmail: string;
  subject: string;
  status: string;
  scheduledAt: Date;
  sentAt?: Date | null;
  attempt?: number;
  providerId?: string | null;
  failureCode?: string | null;
  createdAt: Date;
}): Promise<void> {
  try {
    await esClient.index({
      index: INDEX_NAME,
      id: record.recipientId,
      document: record,
      refresh: false,
    });
  } catch (error) {
    logger.error({ err: error, recipientId: record.recipientId }, "Failed to index email record");
    throw error;
  }
}

export async function searchEmails(params: {
  ownerId: string;
  query?: string;
  status?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}): Promise<{ items: unknown[]; total: number }> {
  const { ownerId, query, status, from, to, page, limit } = params;

  const must: object[] = [{ term: { ownerId } }];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ["subject^2", "normalizedEmail"],
        type: "best_fields",
      },
    });
  }

  if (status) {
    must.push({ term: { status } });
  }

  if (from || to) {
    const range: Record<string, string> = {};
    if (from) range.gte = from.toISOString();
    if (to) range.lte = to.toISOString();
    must.push({ range: { scheduledAt: range } });
  }

  const result = await esClient.search({
    index: INDEX_NAME,
    from: (page - 1) * limit,
    size: limit,
    query: { bool: { must } },
    sort: [{ scheduledAt: { order: "desc" } }],
  });

  const total =
    typeof result.hits.total === "object" ? result.hits.total.value : result.hits.total ?? 0;

  return {
    items: result.hits.hits.map((hit) => hit._source),
    total,
  };
}

export { INDEX_NAME };
