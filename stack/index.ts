/* eslint-disable no-console */
import path from 'path';

import esbuildPluginTsc from 'esbuild-plugin-tsc';
import {
	NextjsSite,
	Permissions,
	EventBus,
	StackContext,
	Topic,
} from 'sst/constructs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import './load-environ';

import { StackApi } from './api';
import { eventHandlerEndpoints, apiEndpoints } from './build-index';
import { makeLogGroup } from './log-group';
import { installOtelPackages, otelBaseConfig } from './otel';
import { getDomainConfig } from './domain';
import { prepareNextBuild, restoreAfterNextBuild } from './build-prep';
import { getDataResources } from './data';
import { getCleanEnvironment } from './helpers';
import { getLayers } from './layers';
import { prepareHandlerExport } from './functions';

export function Stack({ stack, ...rest }: StackContext) {
	const openTelemetry = null; // makeOtelConfig();
	const otelEnabled = false; // openTelemetry.length > 0;
	const copyFiles: { from: string }[] = []; //openTelemetry.filter((x) => x !== null) as {
	//from: string;
	//}[];
	const domain = getDomainConfig({ stack, ...rest });
	const { tables, buckets } = getDataResources({ stack, ...rest });
	const { baseLayers, layerCache } = getLayers({
		stack,
		...rest,
		openTelemetry,
	});

	prepareNextBuild();
	const site = new NextjsSite(stack, 'site', {
		bind: [buckets.files],
		customDomain: domain.siteCustomDomain,
		environment: {
			NEXT_PUBLIC_API_URL: domain.publicApiUrl,
		},
		logging: 'combined',
		cdk: {
			server: {
				logRetention: otelEnabled
					? RetentionDays.ONE_DAY
					: RetentionDays.TWO_WEEKS,
			},
		},
		experimental: {
			disableDynamoDBCache: true,
		},
	});
	restoreAfterNextBuild();

	const baseBinds = [buckets.files, tables.electrodb];
	const baseEnvironment = getCleanEnvironment({
		...otelBaseConfig,
		JWT_SECRET: [process.env.JWT_SECRET],
		ALLOWED_EMAILS: [process.env.ALLOWED_EMAILS],
		OAUTH_CLIENT_ID: [process.env.OAUTH_CLIENT_ID],
		TABLE_ELECTRODB: tables.electrodb.tableName,
		SITE_DOMAIN: domain.siteDomain,
		BUCKET_FILES: buckets.files.bucketName,

		SERVICE_NAMESPACE: 'servobill',
		// NODE_OPTIONS: '--enable-source-maps',
		NODE_OPTIONS: '--enable-source-maps --require ./tracing.cjs',
	});

	const bus = new EventBus(stack, 'bus', {
		defaults: {
			retries: 5,
			function: {
				tracing: 'disabled',
				disableCloudWatchLogs: otelEnabled,
				copyFiles,
				environment: {
					...baseEnvironment,
				},
				permissions: [...baseBinds],
				nodejs: {
					format: 'cjs',
					install: [...installOtelPackages],
					esbuild: {
						external: ['@sparticuz/chromium'],
					},
				},
				runtime: 'nodejs20.x',
				timeout: 60 * 5, // 5 minutes
				memorySize: 1024,
			},
		},
	});

	for (const endpoint of eventHandlerEndpoints) {
		prepareHandlerExport(endpoint);

		bus.addRules(stack, {
			[`rule${endpoint.eventType
				.split('.')
				.map((namePart) => {
					// ucfirst
					return namePart[0].toUpperCase() + namePart.slice(1);
				})
				.join('')}`]: {
				pattern: { detailType: [endpoint.eventType] },
				targets: {
					handler: {
						function: {
							handler: `${endpoint.file}.${endpoint.handler}`,
							layers: [
								...baseLayers,
								...(endpoint.layers || []).map(
									(layerPath) => layerCache[layerPath],
								),
							],
							logGroup: makeLogGroup(stack, [
								'eventhandler',
								endpoint.eventType,
							]),
							environment: {
								OTEL_SERVICE_NAME: `${
									stack.stackName
								}-EVENT-${endpoint.eventType.replaceAll('.', '-')}`,
							},
						},
					},
				},
			},
		});
	}

	const deliveryTopic = new Topic(stack, 'DeliveryTopic', {
		subscribers: {
			EmailDelivery: {
				function: {
					handler: 'src/backend/events/delivery/status/handler.handler',
					layers: [...baseLayers],
					environment: {
						OTEL_SERVICE_NAME: `${stack.stackName}-DELIVERY-EMAIL`,
					},
				},
			},
		},
		defaults: {
			function: {
				tracing: 'disabled',
				disableCloudWatchLogs: otelEnabled,
				copyFiles,
				environment: {
					...baseEnvironment,
				},
				permissions: [...baseBinds],
				nodejs: {
					format: 'cjs',
					install: [...installOtelPackages],
					esbuild: {},
				},
				runtime: 'nodejs20.x',
				timeout: 60 * 1, // 5 minutes
				memorySize: 1024,
			},
		},
	});

	const api = StackApi(
		{ stack, ...rest },
		baseLayers,
		layerCache,
		apiEndpoints,
		{
			customDomain: domain.apiCustomDomain,
			cors: {
				allowOrigins: site.customDomainUrl
					? [site.customDomainUrl]
					: [site.url!],
				allowMethods: ['ANY'],
				allowHeaders: [
					'Content-Type',
					'Authorization',
					'Apollo-Require-Preflight',
					'Content-Length',
					'Cookie',
				],
				allowCredentials: true,
			},
			function: {
				tracing: 'disabled',
				disableCloudWatchLogs: otelEnabled,
				copyFiles,
				environment: {
					...baseEnvironment,
					EVENT_BUS_NAME: bus.eventBusName,
				},
				runtime: 'nodejs20.x',
				nodejs: {
					format: 'cjs',
					esbuild: {
						plugins: [
							esbuildPluginTsc({
								tsconfigPath: path.resolve('tsconfig.json'),
							}),
						],
					},
					// splitting: true,
					install: [
						'graphql',
						'graphql-tools',
						'type-graphql',
						// ...installOtelPackages,
					],
				},
			},
		},
	);

	api.bind([...baseBinds]);
	api.bind([bus]);

	const permissions: Permissions = ['s3', 'ses'];
	api.attachPermissions(permissions);
	bus.attachPermissions(permissions);

	stack.addOutputs({
		// SiteUrl: site.url,
		// SiteCustomUrl: site.customDomainUrl,
		// ApiUrl: api.url,
		// ApiCustomUrl: api.customDomainUrl,
		DeliveryTopicArn: deliveryTopic.topicArn,
	});
}
