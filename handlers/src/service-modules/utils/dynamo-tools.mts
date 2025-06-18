import {AMPRule,
TagV2} from '../../types/index.mjs';

// ===========================
// Prometheus Alarms Table
// ===========================
// Table Name: PrometheusAlarms
interface PrometheusAlarmItem {
  // Primary Key
  PK: string;  // "ENGINE#<engine>"
  SK: string;  // "ARN#<arn>"

  // Core Attributes
  arn: string;              // Full ARN
  engine: string;           // Engine name
  hostID: string;           // Host identifier
  tags: TagV2[];            // Array of tags
  ampRules: AMPRule[];      // Prometheus rules

  // Metadata
  lastUpdated: string;      // ISO 8601 timestamp
  version: number;          // For optimistic locking
  ttl?: number;             // Optional TTL epoch timestamp
}

// GSI Definitions
interface PrometheusAlarmsGSIs {
  // GSI1: Query by hostID
  GSI1PK: string;  // "HOST#<hostID>"
  GSI1SK: string;  // "ENGINE#<engine>#ARN#<arn>"

  // GSI2: Query by tag (optional, if needed)
  GSI2PK?: string; // "TAG#<tagKey>#<tagValue>"
  GSI2SK?: string; // "ENGINE#<engine>#ARN#<arn>"
}

// ===========================
// CloudWatch Alarms Table
// ===========================

// Table Name: CloudWatchAlarms
interface CloudWatchAlarmItem {
  // Primary Key
  PK: string;  // "ENGINE#<engine>"
  SK: string;  // "ARN#<arn>"

  // Core Attributes
  arn: string;              // Full ARN
  engine: string;           // Engine name
  hostID: string;           // Host identifier
  tags: TagV2[];            // Array of tags
  alarms: string[]; // CloudWatch alarms

  // Metadata
  lastUpdated: string;      // ISO 8601 timestamp
  version: number;          // For optimistic locking
  ttl?: number;             // Optional TTL epoch timestamp
}

// GSI Definitions (same structure as Prometheus)
interface CloudWatchAlarmsGSIs {
  // GSI1: Query by hostID
  GSI1PK: string;  // "HOST#<hostID>"
  GSI1SK: string;  // "ENGINE#<engine>#ARN#<arn>"

  // GSI2: Query by tag (optional, if needed)
  GSI2PK?: string; // "TAG#<tagKey>#<tagValue>"
  GSI2SK?: string; // "ENGINE#<engine>#ARN#<arn>"
}
