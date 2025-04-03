import {
  ServiceType,
  EventParsingPattern,
  ProcessorConstructor,
} from './types.mjs';
import {EventPatterns} from './enums.mjs';
import {
  ALBProcessor,
  CloudFrontProcessor,
  EC2Processor,
  OpenSearchProcessor,
  RDSProcessor,
  RDSClusterProcessor,
  Route53ResolverProcessor,
  SQSProcessor,
  StepFunctionProcessor,
  TargetGroupProcessor,
  TransitGatewayProcessor,
  VPNProcessor,
} from './processors-temp.mjs';
import {ServiceProcessor} from './service-processor.mjs';
import {SQSRecord} from 'aws-lambda';
import * as logging from '@nr1e/logging';

const log: logging.Logger = logging.getLogger('processor-registry');

/**
 * Registry for service processors
 * Manages service processor classes and handles instantiation
 */
export class ProcessorRegistry {
  // Registry of processor classes and their event patterns in a map for quick access
  private static registry: Map<
    ServiceType,
    {
      processorClass: ProcessorConstructor;
      eventParsingPattern: string;
    }
  > = new Map();

  /**
   * Initializes the registry map with all processor classes
   * @IMPORTANT: When adding a new processor, you will add it to this method.
   */
  static initialize(): void {
    // Initialize with default processors
    this.registerProcessor('alb', EventPatterns.alb, ALBProcessor);

    this.registerProcessor(
      'cloudfront',
      EventPatterns.cloudfront,
      CloudFrontProcessor,
    );

    this.registerProcessor('ec2', EventPatterns.ec2, EC2Processor);

    this.registerProcessor(
      'opensearch',
      EventPatterns.opensearch,
      OpenSearchProcessor,
    );

    this.registerProcessor('rds', EventPatterns.rds, RDSProcessor);

    this.registerProcessor(
      'rdscluster',
      EventPatterns.rdscluster,
      RDSClusterProcessor,
    );

    this.registerProcessor(
      'route53resolver',
      EventPatterns.route53resolver,
      Route53ResolverProcessor,
    );

    this.registerProcessor('sqs', EventPatterns.sqs, SQSProcessor);

    this.registerProcessor('sfn', EventPatterns.sfn, StepFunctionProcessor);

    this.registerProcessor(
      'targetgroup',
      EventPatterns.targetgroup,
      TargetGroupProcessor,
    );

    this.registerProcessor(
      'transitgateway',
      EventPatterns.transitgateway,
      TransitGatewayProcessor,
    );

    this.registerProcessor('vpn', EventPatterns.vpn, VPNProcessor);

    log
      .info()
      .str('class', 'ProcessorRegistry')
      .str('function', 'initialize')
      .num('registeredProcessors', this.registry.size)
      .msg('Processor registry initialized');
  }

  /**
   * Registers a new processor type
   * @param serviceType The service type identifier
   * @param eventParsingPattern The ARN pattern for this service
   * @param processorClass The processor class for this service
   */
  static registerProcessor(
    serviceType: ServiceType,
    eventParsingPattern: EventParsingPattern,
    processorClass: ProcessorConstructor,
  ): void {
    this.registry.set(serviceType, {
      processorClass,
      eventParsingPattern,
    });

    log
      .debug()
      .str('class', 'ProcessorRegistry')
      .str('function', 'registerProcessor')
      .str('serviceType', serviceType)
      .msg('Registered processor for service type');
  }

  /**
   * Gets processor configuration by service type
   * @param serviceType The service type to look up
   * @returns The processor configuration or undefined if not found
   */
  static getProcessorConfig(serviceType: ServiceType):
    | {
        processorClass: ProcessorConstructor;
        eventParsingPattern: string;
      }
    | undefined {
    return this.registry.get(serviceType);
  }

  /**
   * Creates a new processor instance a service type with available records to process
   * @param serviceType The service type to create a processor for
   * @param records The SQS records to process
   * @returns A new processor instance or undefined if not found
   */
  static createProcessor(
    serviceType: ServiceType,
    records: SQSRecord[],
  ): ServiceProcessor | undefined {
    const config = this.getProcessorConfig(serviceType);
    if (!config) {
      log
        .warn()
        .str('class', 'ProcessorRegistry')
        .str('function', 'createProcessor')
        .str('serviceType', serviceType)
        .msg('No processor registered for service type');
      return undefined;
    }

    const ProcessorClass = config.processorClass;

    log
      .debug()
      .str('class', 'ProcessorRegistry')
      .str('function', 'createProcessor')
      .str('serviceType', serviceType)
      .str('processorClass', ProcessorClass.name)
      .num('recordCount', records.length)
      .msg('Creating processor instance');

    try {
      /** @return processor class instance */
      return new ProcessorClass(records);
    } catch (error) {
      log
        .error()
        .str('class', 'ProcessorRegistry')
        .str('function', 'createProcessor')
        .str('serviceType', serviceType)
        .err(error)
        .msg('Failed to instantiate processor');
      return undefined;
    }
  }

  /**
   * Gets all registered service types
   * @returns An array of all registered service types
   */
  static getServiceTypes(): ServiceType[] {
    return Array.from(this.registry.keys());
  }
}
