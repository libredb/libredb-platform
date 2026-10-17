// Step 2 of the Docker graph: pulls by digest every image the compose project runs, and the PostgreSQL
// image whose psql the installer runs, which no service runs with an external PostgreSQL, unless the Docker Engine
// already holds it.
import { composeImages } from "../docker/project";
import { planImages, type ImageAction, type ObservedImage } from "../docker/images";
import type { Step } from "../engine/step";
import { renderedCompose } from "./deploy";
import type { DockerContext } from "./docker-context";

const references = (context: DockerContext) => [
  ...new Set([...composeImages(renderedCompose(context.desired)), context.desired.images.postgres]),
];

export const imagesStep: Step<DockerContext, ObservedImage[], ImageAction> = {
  name: "images",
  inputs: (context) => ({ images: references(context) }),
  observe: ({ context }) =>
    Promise.all(
      references(context).map(async (reference) => ({
        reference,
        present: (await context.docker.imageInspect(reference)) !== undefined,
      })),
    ),
  plan: (observed) => planImages(observed),
  async apply(actions, { context }) {
    for (const action of actions) await context.docker.pull(action.reference);
  },
};
