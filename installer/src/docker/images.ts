// Plans the images step: pull every image the compose project runs that the Docker Engine does not hold yet.
import type { Action } from "../engine/step";

export interface ImageAction extends Action {
  kind: "image";
  reference: string;
}

export interface ObservedImage {
  reference: string;
  present: boolean;
}

export function planImages(observed: readonly ObservedImage[]): ImageAction[] {
  return observed
    .filter((image) => !image.present)
    .map((image) => ({ kind: "image", reference: image.reference, summary: `pull ${image.reference}` }));
}
