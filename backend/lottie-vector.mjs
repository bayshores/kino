function recordName(name, drawingIndex, part) {
  return `${name} ${part} ${drawingIndex + 1}`;
}

function requireTransform(transform) {
  if (
    !transform ||
    typeof transform !== "object" ||
    Array.isArray(transform) ||
    !Object.hasOwn(transform, "o")
  ) {
    throw new TypeError("Lottie vector export requires a sampled transform with opacity.");
  }
  return transform;
}

function requireAllocator(nextIndex) {
  if (typeof nextIndex !== "function") {
    throw new TypeError("Lottie vector export requires an index allocator.");
  }
}

function allocateIndex(nextIndex, allocated) {
  const index = nextIndex();
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new TypeError("Lottie vector index allocator must return positive integers.");
  }
  if (allocated.has(index)) {
    throw new Error(`Lottie vector index allocator returned duplicate index ${index}.`);
  }
  allocated.add(index);
  return index;
}

function validatePaints(paints) {
  if (!Array.isArray(paints)) {
    throw new TypeError("Lottie vector export requires an array of paint records.");
  }

  return paints.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Lottie vector paint ${index + 1} must be an object.`);
    }
    if (record.content !== undefined && !Array.isArray(record.content)) {
      throw new TypeError(`Lottie vector paint ${index + 1} content must be an array.`);
    }

    const hasMatte = record.matte !== undefined;
    const hasStroke = record.stroke !== undefined;
    const hasMatteType = record.matteType !== undefined;
    if (hasMatteType && record.matteType !== 1 && record.matteType !== 2) {
      throw new TypeError(`Lottie vector paint ${index + 1} matteType must be 1 or 2.`);
    }

    if (!hasMatte) {
      if (hasStroke || hasMatteType) {
        throw new TypeError(
          `Lottie vector paint ${index + 1} has incomplete matte data; stroke and matteType require a matte silhouette.`,
        );
      }
      if (record.content === undefined) {
        throw new TypeError(`Lottie vector paint ${index + 1} requires content when it has no matte.`);
      }
      return { content: record.content, matte: null };
    }

    if (!Array.isArray(record.matte) || record.matte.length === 0) {
      throw new TypeError(`Lottie vector paint ${index + 1} matte must contain shape groups.`);
    }
    if (!Array.isArray(record.stroke) || record.stroke.length === 0) {
      throw new TypeError(`Lottie vector paint ${index + 1} matte requires stroke shape groups.`);
    }
    if (!hasMatteType) {
      throw new TypeError(`Lottie vector paint ${index + 1} matte requires matteType 1 or 2.`);
    }

    return {
      content: record.content ?? [],
      matte: {
        stroke: record.stroke,
        silhouette: record.matte,
        type: record.matteType,
      },
    };
  });
}

function vectorShapeLayer(shapes, transform, frameCount, nextIndex, allocated, name) {
  return {
    ddd: 0,
    ind: allocateIndex(nextIndex, allocated),
    ty: 4,
    nm: name,
    sr: 1,
    ks: structuredClone(transform),
    ao: 0,
    shapes: structuredClone(shapes),
    ip: 0,
    op: frameCount,
    st: 0,
    bm: 0,
  };
}

/** Compose sampled native shape groups, using alpha mattes for aligned strokes. */
export function vectorLayer(
  paints,
  transform,
  { name, frameCount, nextIndex, compose } = {},
) {
  const records = validatePaints(paints);
  requireTransform(transform);
  requireAllocator(nextIndex);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new TypeError("Lottie vector export requires a positive integer frame count.");
  }

  const layerName = String(name ?? "Vector");
  const allocated = new Set();
  if (!records.some((record) => record.matte)) {
    const groups = records.flatMap((record) => record.content);
    return vectorShapeLayer(
      groups,
      transform,
      frameCount,
      nextIndex,
      allocated,
      layerName,
    );
  }

  if (typeof compose !== "function") {
    throw new TypeError("Lottie vector matte export requires a composition callback.");
  }

  const childTransform = structuredClone(transform);
  childTransform.o = { a: 0, k: 100 };
  const content = [];
  records.forEach((record, drawingIndex) => {
    if (record.content.length > 0) {
      content.push(
        vectorShapeLayer(
          record.content,
          childTransform,
          frameCount,
          nextIndex,
          allocated,
          recordName(layerName, drawingIndex, "content"),
        ),
      );
    }
    if (!record.matte) return;

    const target = vectorShapeLayer(
      record.matte.stroke,
      childTransform,
      frameCount,
      nextIndex,
      allocated,
      recordName(layerName, drawingIndex, "stroke"),
    );
    const silhouette = vectorShapeLayer(
      record.matte.silhouette,
      childTransform,
      frameCount,
      nextIndex,
      allocated,
      recordName(layerName, drawingIndex, "matte"),
    );
    silhouette.td = 1;
    target.tt = record.matte.type;
    target.tp = silhouette.ind;
    content.push(target, silhouette);
  });

  const wrapper = compose(content, layerName);
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
    throw new TypeError("Lottie vector composition callback must return a layer object.");
  }
  if (!wrapper.ks || typeof wrapper.ks !== "object" || Array.isArray(wrapper.ks)) {
    throw new TypeError("Lottie vector composition callback must return a layer with a transform.");
  }
  wrapper.ks.o = structuredClone(transform.o);
  return wrapper;
}
