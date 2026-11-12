import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_VERSION, MAX_TIME } from "./schema.js";
import { convertLayerToShape } from "./shapeConversion.js";
import { presetAnimation } from "./animation.js";
import {
  createDocument,
  createLayer,
  createScene,
  parseDocument,
  uid,
} from "./model.js";

test("component references derive their size and reject missing sources and cycles", () => {
  const source = createScene({id:"source",isComponent:true,width:120,height:80});
  const target = createScene({id:"target",layers:[createLayer("component",{id:"instance",componentSceneId:"source",width:1,height:1})]});
  const doc = createDocument({scenes:[source,target]});
  const normalized = parseDocument(doc);
  assert.equal(normalized.scenes[1].layers[0].width,120);
  assert.equal(normalized.scenes[1].layers[0].height,80);
  target.layers[0].componentSceneId="missing";
  assert.throws(()=>parseDocument(createDocument({scenes:[source,target]})), /main component scene/);
  source.layers.push(createLayer("component",{componentSceneId:source.id}));
  assert.throws(()=>parseDocument(createDocument({scenes:[source]})), /cycle/);
});

test("morphs reject malformed paths and incompatible contours before saving",()=>{
  const layer=createLayer("path",{path:"M0 0L20 0L0 20Z",animations:[{id:"morph",name:"Morph",kind:"custom",start:0,duration:1,easing:"linear",from:{path:"M0 0L20 0L0 20Z"},to:{path:"M0 0L20 0"}}]});
  const doc=createDocument({scenes:[createScene({layers:[layer]})]});
  assert.throws(()=>parseDocument(doc), /open in both paths or closed/);
  layer.animations=[];layer.path="M0 0 C1 2";
  assert.throws(()=>parseDocument(createDocument({scenes:[createScene({layers:[layer]})]})), /requires|Incomplete|missing|arguments/i);
});

test("path fill rules default compatibly, persist, and reject unsupported values and layer types", () => {
  const legacyPath = createLayer("path", {
    id: "legacy-path",
    path: "M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z",
  });
  delete legacyPath.fillRule;
  const oldDocument = createDocument({ scenes: [createScene({ id: "old", layers: [legacyPath] })] });
  const parsedOld = parseDocument(oldDocument);
  assert.equal(parsedOld.scenes[0].layers[0].fillRule, "nonzero");

  const evenodd = createLayer("path", {
    id: "evenodd-path",
    path: legacyPath.path,
    fillRule: "evenodd",
  });
  const roundTrip = parseDocument(JSON.stringify(createDocument({
    scenes: [createScene({ id: "new", layers: [evenodd] })],
  })));
  assert.equal(roundTrip.scenes[0].layers[0].fillRule, "evenodd");
  assert.deepEqual(parseDocument(JSON.stringify(roundTrip)).scenes[0].layers[0], roundTrip.scenes[0].layers[0]);

  for (const [type, fillRule] of [["path", "odd"], ["rectangle", "evenodd"]]) {
    const layer = createLayer(type, { id: `invalid-${type}`, fillRule });
    assert.throws(() => parseDocument(createDocument({
      scenes: [createScene({ id: `scene-${type}`, layers: [layer] })],
    })), /fillRule/);
  }
});

test("factories create an empty editable document and complete layer records", () => {
  const document = createDocument();
  assert.equal(document.version, DOCUMENT_VERSION);
  assert.equal(document.name, "New file");
  assert.equal(document.scenes.length, 1);
  assert.deepEqual(document.scenes[0], {
    id: document.scenes[0].id,
    name: "Scene 1",
    width: 640,
    height: 360,
    duration: 4,
    background: "#ffffff",
    backgroundEnabled: true,
    backgroundAnimations: [],
    isComponent: false,
    aspectLocked: false,
    layers: [],
  });
  assert.equal(new Set([uid(), uid()]).size, 2);

  const layer = createLayer("text");
  for (const field of [
    "id",
    "name",
    "type",
    "parentId",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "scaleX",
    "scaleY",
    "opacity",
    "fill",
    "fillEnabled",
    "stroke",
    "strokeWidth",
    "strokeAlign",
    "radius",
    "cornerRadii",
    "donut",
    "sweep",
    "startAngle",
    "spikes",
    "starThickness",
    "visible",
    "locked",
    "lockAspect",
    "blur",
    "blendMode",
    "isMask",
    "shadow",
    "text",
    "fontFamily",
    "fontSource",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "verticalAlign",
    "textResize",
    "textCase",
    "kerning",
    "ligatures",
    "path",
    "src",
    "mediaStart",
    "mediaDuration",
    "mediaOffset",
    "mediaFreeze",
    "mediaSourceDuration",
    "volume",
    "animations",
  ])
    assert.ok(Object.hasOwn(layer, field), `layer lacks ${field}`);
  assert.equal(layer.text, "Text");
  assert.equal(layer.fontSource, "");
  assert.equal(layer.fontStyle, "normal");
  assert.equal(layer.verticalAlign, "top");
  assert.equal(layer.textResize, "fixed");
  assert.equal(layer.textCase, "normal");
  assert.equal(layer.kerning, true);
  assert.equal(layer.ligatures, true);
  assert.equal(createLayer("rectangle").fontSource, "");
  assert.deepEqual(createScene({ name: "Clip", duration: 8 }).layers, []);
});

test("scene backgrounds validate paints, the enabled switch, and Color-only animation IDs", () => {
  const gradient = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const color = { id: "background-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: gradient } };
  const scene = createScene({ background: gradient, backgroundEnabled: false, backgroundAnimations: [color] });
  const make = (patch) => createDocument({ scenes: [{ ...scene, ...patch }] });
  const parsed = parseDocument(make({})).scenes[0];
  assert.deepEqual(parsed.background, gradient);
  assert.equal(parsed.backgroundEnabled, false);
  assert.equal(parsed.backgroundAnimations[0].unit, "layer");
  assert.throws(() => parseDocument(make({ background: { ...gradient, stops: [] } })), /document\.scenes\[0\]\.background\.stops/);
  assert.throws(() => parseDocument(make({ backgroundEnabled: "false" })), /backgroundEnabled.*true or false/);
  const oldInvalid = { ...make({ backgroundAnimations: "invalid" }), version: 2 };
  delete oldInvalid.scenes[0].backgroundEnabled;
  assert.throws(() => parseDocument(oldInvalid), /backgroundAnimations.*array/);
  for (const invalid of [
    { ...color, from: { x: 0 }, to: { x: 10 } },
    { id: "hide-bg", name: "Hide", kind: "hide", start: 0 },
  ]) assert.throws(() => parseDocument(make({ backgroundAnimations: [invalid] })), /a scene background can only have Color animations/);
  const rectangle = createLayer("rectangle", { animations: [color] });
  assert.throws(() => parseDocument(make({ layers: [rectangle] })), /duplicate animation ID/);
  const noDefaults = { id: "legacy-defaults", layers: [] };
  const defaults = parseDocument(createDocument({ scenes: [noDefaults] })).scenes[0];
  assert.equal(defaults.backgroundEnabled, true);
  assert.deepEqual(defaults.backgroundAnimations, []);
});

test("text properties default for legacy layers and round-trip through parsing", () => {
  const legacyLayer = createLayer("text", { id: "legacy-text" });
  for (const property of [
    "fontStyle",
    "fontSource",
    "verticalAlign",
    "textResize",
    "textCase",
    "kerning",
    "ligatures",
  ]) {
    delete legacyLayer[property];
  }
  const legacy = parseDocument(
    createDocument({
      scenes: [createScene({ id: "legacy-scene", layers: [legacyLayer] })],
    }),
  );
  const legacyText = legacy.scenes[0].layers[0];
  assert.equal(legacyText.fontStyle, "normal");
  assert.equal(legacyText.fontSource, "");
  assert.equal(legacyText.verticalAlign, "top");
  assert.equal(legacyText.textResize, "fixed");
  assert.equal(legacyText.textCase, "normal");
  assert.equal(legacyText.kerning, true);
  assert.equal(legacyText.ligatures, true);

  const expected = {
    fontStyle: "italic",
    fontSource: "/api/media/550e8400-e29b-41d4-a716-446655440000.woff2",
    verticalAlign: "middle",
    textResize: "width-height",
    textCase: "upper",
    kerning: false,
    ligatures: false,
  };
  const layer = createLayer("text", { id: "styled-text", ...expected });
  const parsed = parseDocument(
    createDocument({
      scenes: [createScene({ id: "styled-scene", layers: [layer] })],
    }),
  );
  const roundTrip = parseDocument(JSON.stringify(parsed));
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expected).map((property) => [
        property,
        roundTrip.scenes[0].layers[0][property],
      ]),
    ),
    expected,
  );

  const bundledFont = createLayer("text", {
    id: "bundled-font-text",
    fontSource: "/api/fonts/Inter-400-italic.woff2",
  });
  const bundledRoundTrip = parseDocument(
    JSON.stringify(
      createDocument({
        scenes: [createScene({ layers: [bundledFont] })],
      }),
    ),
  );
  assert.equal(
    bundledRoundTrip.scenes[0].layers[0].fontSource,
    "/api/fonts/Inter-400-italic.woff2",
  );
});

test("text properties reject unsupported enum values and non-boolean shaping flags", () => {
  const invalidValues = [
    ["fontStyle", "oblique"],
    ["verticalAlign", "center"],
    ["textResize", "auto"],
    ["textCase", "title"],
    ["kerning", "yes"],
    ["ligatures", 1],
  ];
  for (const [property, value] of invalidValues) {
    const layer = createLayer("text", {
      id: `invalid-${property}`,
      [property]: value,
    });
    const document = createDocument({
      scenes: [createScene({ layers: [layer] })],
    });
    assert.throws(() => parseDocument(document), new RegExp(property));
  }
});

test("fontSource accepts local font routes and rejects external or unsafe URLs", () => {
  const localSources = [
    "/api/media/550e8400-e29b-41d4-a716-446655440000.ttf",
    "/api/fonts/Inter-400-italic.woff2",
  ];
  for (const [index, fontSource] of localSources.entries()) {
    const document = createDocument({
      scenes: [
        createScene({
          layers: [createLayer("text", { id: `local-font-${index}`, fontSource })],
        }),
      ],
    });
    assert.equal(parseDocument(document).scenes[0].layers[0].fontSource, fontSource);
  }

  const maxLengthFontSource = `/api/fonts/${"a".repeat(495)}.woff2`;
  assert.equal(maxLengthFontSource.length, 512);
  const maxLengthDocument = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("text", {
            id: "max-length-font-source",
            fontSource: maxLengthFontSource,
          }),
        ],
      }),
    ],
  });
  assert.equal(
    parseDocument(maxLengthDocument).scenes[0].layers[0].fontSource,
    maxLengthFontSource,
  );
  const overlongFontSource = `/api/fonts/${"a".repeat(496)}.woff2`;
  assert.equal(overlongFontSource.length, 513);
  const overlongDocument = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("text", {
            id: "overlong-font-source",
            fontSource: overlongFontSource,
          }),
        ],
      }),
    ],
  });
  assert.throws(
    () => parseDocument(overlongDocument),
    /fontSource: cannot exceed 512 characters/,
  );

  const invalidSources = [
    "https://example.com/font.woff2",
    "javascript:alert(1)",
    "/api/media/../font.ttf",
    "/api/fonts/../font.ttf",
    "/api/fonts/%2e%2e.ttf",
    "/api/fonts/Inter.ttf?share=secret",
  ];
  for (const [index, fontSource] of invalidSources.entries()) {
    const document = createDocument({
      scenes: [
        createScene({
          layers: [
            createLayer("text", { id: `invalid-font-${index}`, fontSource }),
          ],
        }),
      ],
    });
    assert.throws(() => parseDocument(document), /fontSource/);
  }
});

test("parseDocument accepts JSON text, fills omitted schema defaults, and retains extension data", () => {
  const parsed = parseDocument(
    JSON.stringify({
      version: 1,
      id: "doc-1",
      name: "Example",
      extension: { source: "round-trip", enabled: true },
      scenes: [{ id: "scene-1", layers: [] }],
    }),
  );
  assert.equal(parsed.scenes[0].name, "Scene 1");
  assert.equal(parsed.scenes[0].width, 640);
  assert.equal(parsed.scenes[0].height, 360);
  assert.equal(parsed.scenes[0].duration, 4);
  assert.deepEqual(parsed.extension, { source: "round-trip", enabled: true });

  const copied = parseDocument(parsed);
  assert.deepEqual(copied, parsed);
  assert.notEqual(copied.scenes, parsed.scenes);
  assert.notEqual(copied.scenes[0], parsed.scenes[0]);
});

test("parseDocument validates versions, bounded dimensions, timing, and gradient stops", () => {
  const document = createDocument();
  assert.throws(
    () => parseDocument({ ...document, version: DOCUMENT_VERSION + 1 }),
    new RegExp(`version.*must be ${DOCUMENT_VERSION}`),
  );
  assert.throws(() => parseDocument({ ...document, version: 0 }), new RegExp(`version.*must be ${DOCUMENT_VERSION}`));
  assert.throws(
    () =>
      parseDocument({
        ...document,
        scenes: [{ ...document.scenes[0], width: Infinity }],
      }),
    /finite and within the supported range|finite number/,
  );
  assert.throws(
    () =>
      parseDocument({
        ...document,
        scenes: [{ ...document.scenes[0], duration: MAX_TIME + 1 }],
      }),
    /duration.*must be a finite number/,
  );

  const gradient = {
    type: "linear",
    angle: 45,
    stops: [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#ffffff" },
    ],
  };
  const strokeGradient = {
    type: "radial",
    angle: 135,
    stops: [
      { offset: 0, color: "#12345680" },
      { offset: 1, color: "#abcdef" },
    ],
  };
  const withGradient = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("rectangle", { id: "shape-fill", fill: gradient }),
          createLayer("rectangle", { id: "shape-stroke", stroke: strokeGradient }),
        ],
      }),
    ],
  });
  const normalizedGradient = parseDocument(withGradient);
  assert.deepEqual(
    normalizedGradient.scenes[0].layers[0].fill,
    gradient,
  );
  assert.deepEqual(normalizedGradient.scenes[0].layers[1].stroke, strokeGradient);
  assert.throws(
    () =>
      parseDocument(
        createDocument({
          scenes: [
            createScene({
              layers: [
                createLayer("rectangle", {
                  id: "shape",
                  fill: {
                    ...gradient,
                    stops: [
                      { offset: 1, color: "#fff" },
                      { offset: 0, color: "#000" },
                    ],
                  },
                }),
              ],
            }),
          ],
        }),
      ),
    /ordered by offset/,
  );
  assert.throws(
    () => parseDocument(createDocument({
      scenes: [createScene({ layers: [createLayer("rectangle", {
        id: "invalid-stroke-gradient",
        stroke: { ...strokeGradient, type: "conic" },
      })] })],
    })),
    /stroke.type.*linear or radial/,
  );
});

test("parametric shape defaults preserve legacy documents and shape values round-trip", () => {
  const legacy = parseDocument({
    version: 1,
    id: "legacy-shape-doc",
    name: "Legacy shapes",
    scenes: [{
      id: "legacy-shape-scene",
      layers: [
        { id: "legacy-rect", type: "rectangle" },
        { id: "legacy-ellipse", type: "ellipse" },
      ],
    }],
  });
  const [rectangle, ellipse] = legacy.scenes[0].layers;
  assert.equal(rectangle.radius, 0);
  assert.equal(rectangle.cornerRadii, null);
  assert.equal(rectangle.strokeAlign, "center");
  assert.equal(ellipse.donut, 0);
  assert.equal(ellipse.sweep, 1);
  assert.equal(ellipse.startAngle, 0);
  assert.equal(createLayer("star").spikes, 5);
  assert.equal(createLayer("star").starThickness, 0.382);

  const values = {
    radius: 13,
    cornerRadii: [2, 4, 6, 8],
    stroke: "#12345680",
    strokeWidth: 3.5,
    strokeAlign: "outside",
  };
  const ellipseValues = { donut: 0.25, sweep: 0.75, startAngle: -45 };
  const starValues = { spikes: 1000, starThickness: 0.4 };
  const document = createDocument({
    scenes: [createScene({ id: "shape-values", layers: [
      createLayer("rectangle", { id: "rounded", ...values }),
      createLayer("ellipse", { id: "arc", ...ellipseValues }),
      createLayer("star", { id: "star-shape", ...starValues }),
    ] })],
  });
  const roundTrip = parseDocument(JSON.stringify(parseDocument(document)));
  assert.deepEqual(roundTrip.scenes[0].layers[0].cornerRadii, values.cornerRadii);
  assert.equal(roundTrip.scenes[0].layers[0].radius, values.radius);
  assert.equal(roundTrip.scenes[0].layers[0].stroke, values.stroke);
  assert.equal(roundTrip.scenes[0].layers[0].strokeWidth, values.strokeWidth);
  assert.equal(roundTrip.scenes[0].layers[0].strokeAlign, values.strokeAlign);
  assert.deepEqual(
    Object.fromEntries(Object.keys(ellipseValues).map((key) => [key, roundTrip.scenes[0].layers[1][key]])),
    ellipseValues,
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(starValues).map((key) => [key, roundTrip.scenes[0].layers[2][key]])),
    starValues,
  );
});

test("the aspect-ratio lock is off in old files, saves and loads, and must be true or false", () => {
  const legacy = parseDocument({
    version: 1,
    id: "legacy-aspect-doc",
    name: "Legacy aspect",
    scenes: [{ id: "legacy-aspect-scene", layers: [{ id: "legacy-aspect-layer", type: "rectangle" }] }],
  });
  assert.equal(legacy.scenes[0].layers[0].lockAspect, false);
  const locked = createDocument({ scenes: [createScene({ layers: [createLayer("image", { id: "photo", lockAspect: true })] })] });
  const saved = parseDocument(JSON.parse(JSON.stringify(locked)));
  assert.equal(saved.scenes[0].layers[0].lockAspect, true);
  for (const value of ["yes", 1, null])
    assert.throws(
      () => parseDocument(createDocument({ scenes: [createScene({ layers: [createLayer("rectangle", { id: "bad-lock", lockAspect: value })] })] })),
      /lockAspect/,
    );
});

test("mediaFreeze null reads as none, an unknown word is still refused", () => {
  const parse = (value) => parseDocument(createDocument({ scenes: [createScene({ layers: [createLayer("video", { id: "clip", src: "/api/media/clip.mp4", mediaFreeze: value })] })] })).scenes[0].layers[0].mediaFreeze;
  assert.equal(parse(null), "none");
  assert.equal(parse("last"), "last");
  assert.throws(() => parse("always"), /mediaFreeze/);
});

test("the fill toggle is on in old files, saves its paint while off, and must be true or false", () => {
  const legacy = parseDocument({
    version: 1,
    id: "legacy-fill-doc",
    name: "Legacy fill",
    scenes: [{ id: "legacy-fill-scene", layers: [{ id: "legacy-fill-layer", type: "rectangle", fill: "#12345680" }] }],
  });
  assert.equal(legacy.scenes[0].layers[0].fillEnabled, true, "a layer saved before the toggle keeps its fill on");
  assert.equal(createLayer("text").fillEnabled, true, "new layers start with their fill on");

  const gradient = { type: "linear", angle: 45, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#00ff00" }] };
  const off = createDocument({ scenes: [createScene({ layers: [createLayer("ellipse", { id: "hidden-fill", fill: gradient, fillEnabled: false })] })] });
  const saved = parseDocument(JSON.parse(JSON.stringify(off)));
  assert.equal(saved.scenes[0].layers[0].fillEnabled, false, "the off state saves and loads");
  assert.deepEqual(saved.scenes[0].layers[0].fill, gradient, "the hidden gradient, angle, and alpha are kept for turning it back on");

  for (const value of ["no", 0, null])
    assert.throws(
      () => parseDocument(createDocument({ scenes: [createScene({ layers: [createLayer("rectangle", { id: "bad-fill", fillEnabled: value })] })] })),
      /fillEnabled/,
    );
});

test("stroke alignment defaults for old files and rejects unsupported positions", () => {
  const legacy = parseDocument({
    version: 1,
    id: "legacy-stroke-doc",
    name: "Legacy stroke",
    scenes: [{
      id: "legacy-stroke-scene",
      layers: [{ id: "legacy-stroke-layer", type: "rectangle" }],
    }],
  });
  assert.equal(legacy.scenes[0].layers[0].strokeAlign, "center");
  assert.throws(
    () => parseDocument(createDocument({
      scenes: [createScene({ layers: [createLayer("rectangle", {
        id: "bad-stroke-position",
        strokeAlign: "middle",
      })] })],
    })),
    /strokeAlign.*center, inside, or outside/,
  );
});

test("parametric shape values reject malformed arrays, ranges, and nonintegral spikes", () => {
  const invalidCases = [
    ["rectangle", "radius", -1],
    ["rectangle", "cornerRadii", [0, 1, 2]],
    ["rectangle", "cornerRadii", [0, 1, 2, 65_537]],
    ["ellipse", "donut", 1.01],
    ["ellipse", "sweep", -0.01],
    ["ellipse", "startAngle", 360_001],
    ["star", "spikes", 1.5],
    ["star", "spikes", 1001],
    ["star", "starThickness", -0.01],
  ];
  for (const [type, property, value] of invalidCases) {
    const document = createDocument({
      scenes: [createScene({ layers: [createLayer(type, {
        id: `invalid-${property}-${type}`,
        [property]: value,
      })] })],
    });
    assert.throws(() => parseDocument(document), new RegExp(property));
  }
});

test("animated shape endpoints are validated against the shape and property bounds", () => {
  const makeDocument = (type, property, value) => createDocument({
    scenes: [createScene({ layers: [createLayer(type, {
      id: `animated-${type}`,
      animations: [{
        id: "shape-operation",
        name: "Shape",
        kind: "custom",
        start: 0,
        duration: 0.8,
        easing: "linear",
        from: { [property]: value },
        to: { [property]: value },
      }],
    })] })],
  });

  assert.deepEqual(
    parseDocument(makeDocument("rectangle", "cornerRadii", [1, 2, 3, 4]))
      .scenes[0].layers[0].animations[0].from.cornerRadii,
    [1, 2, 3, 4],
  );
  assert.throws(() => parseDocument(makeDocument("rectangle", "cornerRadii", [1, 2, 3])), /four corner radii/);
  assert.throws(() => parseDocument(makeDocument("rectangle", "donut", 0.5)), /requires an ellipse layer/);
  assert.throws(() => parseDocument(makeDocument("star", "spikes", 1.5)), /integer/);
});

test("converted paths retain validated primitive operations through a document round trip", () => {
  const rectangle = createLayer("rectangle", { id: "converted-card", radius: 20 });
  rectangle.animations = [presetAnimation("corners", rectangle)];
  const path = convertLayerToShape(rectangle);
  const document = createDocument({ scenes: [createScene({ layers: [path] })] });
  const restored = parseDocument(JSON.stringify(document)).scenes[0].layers[0];
  assert.equal(restored.convertedFrom, "rectangle");
  assert.deepEqual(restored.animations, path.animations);
  assert.equal(restored.path, path.path);
  assert.deepEqual(restored.pathBounds, path.pathBounds);
  const withoutProvenance = { ...path };
  delete withoutProvenance.convertedFrom;
  assert.throws(() => parseDocument({ ...document, scenes: [createScene({ layers: [withoutProvenance] })] }), /requires a rectangle layer/);
  assert.throws(() => parseDocument({ ...document, scenes: [createScene({ layers: [{ ...path, convertedFrom: "ellipse" }] })] }), /requires a rectangle layer/);
  const invalid = structuredClone(document);
  invalid.scenes[0].layers[0].animations[0].to.radius = -1;
  assert.throws(() => parseDocument(invalid), /radius/);
});

test("conversion provenance is restricted to paths and supported original primitives", () => {
  for (const values of [{ type: "rectangle", convertedFrom: "rectangle" }, { type: "path", convertedFrom: "text" }, { type: "path", convertedFrom: null }]) {
    const document = createDocument({ scenes: [createScene({ layers: [createLayer(values.type, values)] })] });
    assert.throws(() => parseDocument(document), /convertedFrom/);
  }
});

test("animated stroke endpoints validate supported layers, hex colors, and widths", () => {
  const makeDocument = (type, from, to = from) => createDocument({
    scenes: [createScene({ layers: [createLayer(type, {
      id: `animated-stroke-${type}`,
      ...(type === "path" ? { path: "M0 0 L1 1" } : {}),
      ...(type === "component" ? { componentSceneId: "stroke-source" } : {}),
      animations: [{
        id: "stroke-operation",
        name: "Stroke",
        kind: "custom",
        start: 0,
        duration: 0.8,
        easing: "linear",
        from,
        to,
      }],
    })] })],
  });

  for (const type of ["rectangle", "ellipse", "star", "path", "text", "image", "video", "group"]) {
    const normalized = parseDocument(makeDocument(type, {
      stroke: "#11223380",
      strokeWidth: 0,
    }));
    assert.equal(normalized.scenes[0].layers[0].animations[0].from.stroke, "#11223380");
    assert.equal(normalized.scenes[0].layers[0].animations[0].from.strokeWidth, 0);
  }

  const strokeGradient = {
    type: "linear",
    angle: 45,
    stops: [
      { offset: 0, color: "#11223380" },
      { offset: 1, color: "#445566" },
    ],
  };
  const normalizedGradient = parseDocument(
    makeDocument("rectangle", { stroke: strokeGradient }),
  );
  assert.deepEqual(
    normalizedGradient.scenes[0].layers[0].animations[0].from.stroke,
    strokeGradient,
  );

  assert.throws(() => parseDocument(makeDocument("audio", { stroke: "#ffffff" })), /requires a rectangle, ellipse, star, path, text, group, image, or video layer/);
  assert.throws(() => parseDocument(makeDocument("component", { strokeWidth: 2 })), /requires a rectangle, ellipse, star, path, text, group, image, or video layer/);
  assert.throws(() => parseDocument(makeDocument("rectangle", { stroke: "red" })), /hex color/);
  assert.throws(() => parseDocument(makeDocument("rectangle", {
    stroke: { ...strokeGradient, stops: [{ offset: 0, color: "#000000" }] },
  })), /stroke.stops.*at least two/);
  assert.throws(() => parseDocument(makeDocument("rectangle", { strokeWidth: -0.1 })), /strokeWidth.*0 to 10000/);
  assert.throws(() => parseDocument(makeDocument("rectangle", { strokeWidth: 10_000.1 })), /strokeWidth.*0 to 10000/);
});

test("parseDocument enforces unique IDs and valid acyclic group parents", () => {
  const duplicateLayers = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("rectangle", { id: "same" }),
          createLayer("ellipse", { id: "same" }),
        ],
      }),
    ],
  });
  assert.throws(() => parseDocument(duplicateLayers), /duplicate layer ID/);

  const duplicateScenes = createDocument({
    scenes: [createScene({ id: "same" }), createScene({ id: "same" })],
  });
  assert.throws(() => parseDocument(duplicateScenes), /duplicate scene ID/);

  const nonGroupParent = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("rectangle", { id: "parent" }),
          createLayer("ellipse", { id: "child", parentId: "parent" }),
        ],
      }),
    ],
  });
  assert.throws(() => parseDocument(nonGroupParent), /must reference a group/);

  const cycle = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("group", { id: "group-a", parentId: "group-b" }),
          createLayer("group", { id: "group-b", parentId: "group-a" }),
        ],
      }),
    ],
  });
  assert.throws(() => parseDocument(cycle), /contains a cycle/);
});

test("parseDocument rejects unsafe URLs, accessors, and executable object fields", () => {
  const document = createDocument({
    scenes: [
      createScene({
        layers: [
          createLayer("image", { id: "image", src: "javascript:alert(1)" }),
        ],
      }),
    ],
  });
  assert.throws(() => parseDocument(document), /script URLs are not allowed/);

  const accessorDocument = createDocument();
  let getterCalled = false;
  Object.defineProperty(accessorDocument, "name", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "unsafe";
    },
  });
  assert.throws(
    () => parseDocument(accessorDocument),
    /accessors are not allowed/,
  );
  assert.equal(getterCalled, false);

  assert.throws(
    () =>
      parseDocument(
        '{"version":1,"id":"d","name":"x","__proto__":{},"scenes":[]}',
      ),
    /unsafe field name/,
  );
  assert.throws(() => parseDocument("{not json"), /invalid JSON/);
});
