// The entry point Lambda runs: it wires the handler to the real ECS and CloudWatch clients that come with
// the Node runtime, and to its settings in the environment. The logic is in decide.mjs and handler.mjs;
// this file only reads and writes. It is NOT covered by the unit tests (they use stand-in clients) and is
// first exercised by the rehearsal (ticket 44), where the two things to confirm are written below.
//
// Settings (set when the function is created; none is a secret except the first):
//   GRAFT_WAKE_SECRET      the shared secret a visit must carry
//   GRAFT_SERVICE_ARN      the ARN of the one service this function may change
//   GRAFT_LB_DIMENSION     the load balancer's CloudWatch name, "app/<name>/<id>", for the request count
//
// To confirm in the rehearsal: (1) the runtime's ECS client has UpdateExpressGatewayServiceCommand (Express
// Mode is new; if it does not, the function is packaged with a newer client); (2) the load balancer's
// request count does not include its own health checks (if it does, idle will never read as zero and the
// count has to be filtered).
import {
  ECSClient,
  ListTagsForResourceCommand,
  TagResourceCommand,
  DescribeServicesCommand,
  UpdateExpressGatewayServiceCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { makeHandler } from "./handler.mjs";

const TAG_WARM = "graft-warm-until";
const TAG_WOKEN = "graft-woken-at";

const ecs = new ECSClient({});
const cloudwatch = new CloudWatchClient({});
const serviceArn = process.env.GRAFT_SERVICE_ARN ?? "";

const asNumber = (text) => {
  const n = Number(text);
  return text !== undefined && text !== "" && Number.isFinite(n) ? n : null;
};

export const handler = makeHandler({
  secret: process.env.GRAFT_WAKE_SECRET ?? "",
  now: () => Date.now(),
  log: (line) => console.log(line),
  service: {
    async read() {
      const [described, tagged] = await Promise.all([
        ecs.send(
          new DescribeServicesCommand({ cluster: serviceArn.split("/")[1], services: [serviceArn] }),
        ),
        ecs.send(new ListTagsForResourceCommand({ resourceArn: serviceArn })),
      ]);
      const tags = Object.fromEntries((tagged.tags ?? []).map((t) => [t.key, t.value]));
      // a service started by hand (`make unpark`) has no wake note, so the newest running task's start
      // counts as the moment it came up: an empty count right after a start is never read as idle
      const cluster = serviceArn.split("/")[1];
      const listed = await ecs.send(
        new ListTasksCommand({ cluster, serviceName: serviceArn.split("/")[2], desiredStatus: "RUNNING" }),
      );
      const tasks = listed.taskArns?.length
        ? ((await ecs.send(new DescribeTasksCommand({ cluster, tasks: listed.taskArns }))).tasks ?? [])
        : [];
      const startedAt = Math.max(0, ...tasks.map((t) => t.startedAt?.getTime() ?? t.createdAt?.getTime() ?? 0));
      return {
        desired: described.services?.[0]?.desiredCount ?? 0,
        warmUntil: asNumber(tags[TAG_WARM]),
        wokenAt: Math.max(asNumber(tags[TAG_WOKEN]) ?? 0, startedAt) || null,
      };
    },
    async scale(tasks) {
      // the same shape `aws-dev.sh park` and `unpark` use, including the target value Express needs
      await ecs.send(
        new UpdateExpressGatewayServiceCommand({
          serviceArn,
          scalingTarget: {
            minTaskCount: tasks,
            maxTaskCount: tasks,
            autoScalingMetric: "AVERAGE_CPU",
            autoScalingTargetValue: 60,
          },
        }),
      );
    },
    async markWoken(at) {
      await ecs.send(
        new TagResourceCommand({ resourceArn: serviceArn, tags: [{ key: TAG_WOKEN, value: String(at) }] }),
      );
    },
  },
  metrics: {
    // the sum of requests the load balancer handled in the window; null when CloudWatch has nothing yet
    async requests(windowMs) {
      const end = new Date();
      const start = new Date(end.getTime() - windowMs);
      const out = await cloudwatch.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/ApplicationELB",
          MetricName: "RequestCount",
          Dimensions: [{ Name: "LoadBalancer", Value: process.env.GRAFT_LB_DIMENSION ?? "" }],
          StartTime: start,
          EndTime: end,
          Period: 300,
          Statistics: ["Sum"],
        }),
      );
      const points = out.Datapoints ?? [];
      // A load balancer sends CloudWatch nothing at all while no request reaches it, so an idle service
      // has NO data points, and that is a count of zero. (A failed call is not: it throws, and the
      // handler turns that into "no count to go on".) The lag after a start is covered by the minimum
      // up-time in decide.mjs, measured from the newest task's start.
      return points.reduce((n, p) => n + (p.Sum ?? 0), 0);
    },
  },
});
