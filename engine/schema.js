/**
 * kino's portable project format. Coordinates and dimensions are pixels;
 * animation times are seconds. Layers are ordered back to front. Children use
 * coordinates relative to their parent group. Design values remain the resting
 * state; timed operations change only the properties they explicitly name.
 * lockAspect is an editor setting (editing width or height keeps the proportions); drawing and
 * exports ignore it.
 * fillEnabled false turns a layer's Fill off: drawing and every export paint no fill, and `fill`
 * keeps the paint for turning it back on. Fill animations do not turn it on.
 * A mask layer (isMask) is drawn as a luminance mask over the next visible layer
 * above it. In a mask group (isMaskGroup), the group's bottom-most mask layer
 * instead masks every visible layer above it in that group. maskInvert swaps inside and
 * outside, and maskMode "alpha" masks by transparency (the mask group's values win).
 *
 * @typedef {'rectangle'|'ellipse'|'star'|'text'|'image'|'video'|'path'|'group'|'audio'|'component'} LayerType
 * @typedef {{type:'linear'|'radial', angle:number, stops:Array<{offset:number,color:string}>}} Gradient
 * @typedef {string|Gradient} Paint
 * @typedef {{enabled:boolean,radius:number,blend:number}} BackgroundBlur
 *   Optional on a layer; missing members default to enabled false, radius 4 px and blend 20%.
 * @typedef {{enabled:boolean,refraction:number,depth:number,dispersion:number,frost:number,
 *   lightIntensity:number,lightAngle:number,blend:number}} Glass
 *   Optional on a layer; missing members use the Glass defaults documented in backdropStyles.js.
 * @typedef {{start:number,end:number,style:{fontFamily?:string,fontSource?:string,
 *   fontWeight?:number,fontStyle?:'normal'|'italic',fontSize?:number,fill?:Paint,
 *   letterSpacing?:number}}} TextStyleRange
 *   Range offsets use UTF-16 positions in stored text, on grapheme boundaries.
 * @typedef {{x?:number,y?:number,width?:number,height?:number,rotation?:number,
 *   scaleX?:number,scaleY?:number,opacity?:number,blur?:number,backgroundBlur?:BackgroundBlur,
 *   glass?:Glass,fill?:string|Gradient,
 *   radius?:number,cornerRadii?:number[],donut?:number,sweep?:number,startAngle?:number,
 *   spikes?:number,starThickness?:number,stroke?:string|Gradient,strokeWidth?:number,path?:string,
 *   shadow?:{color:string,x:number,y:number,blur:number}|null,letterSpacing?:number,
 *   lineHeight?:number,reveal?:{progress:number,direction:'up'|'down'|'left'|'right',softness:number,shape?:'linear'|'radial'|'iris'|'clock',angle?:number,centerX?:number,centerY?:number,edgeColor?:string,edgeWidth?:number},
 *   effectPreset?:{id:string,parameters:Object,progress:number},volume?:number,speed?:number,lowpass?:number}} Values
 *   A Shadow animation's `shadow` may be null (no shadow): it then fades in or out as the other
 *   end's shadow with zero alpha (see shadowInterpolation.js).
 *   `letterSpacing` (percent of the font size) is only animated on text layers. A Letter spacing
 *   animation may leave it out of `from`: it then starts from the value the layer has when it
 *   starts (the design value, or where an earlier Letter spacing animation left it).
 *   `lineHeight` (a multiple of the font size, 0.01 to 100) is also only animated on text layers,
 *   and a Line height animation may leave it out of `from` in the same way (lineHeight.js).
 *   `volume` (0 to 4, like the layer's volume; 1 is the file as recorded) is only animated on video and audio layers; the
 *   preview and the exported sound follow it (animation.js volumeAt, backend/volume-track.mjs).
 *   `lowpass` (a cutoff in Hz, 20 to 20000, like the layer's optional lowpass) is also only
 *   animated on video and audio layers; it moves in octaves (animation.js lowpassSampler,
 *   backend/lowpass-track.mjs).
 *   `speed` (0.05 to 16, times normal speed) is only animated on video, audio and GIF layers: it
 *   sets how fast the clip plays its file, and the file time is the integral of the speed
 *   (engine/mediaTime.js). It never moves the layer, so the motion checks ignore it.
 * @typedef {{id:string,name:string,kind:'in'|'out'|'custom',start:number,duration:number,
 *   easing:string|[number,number,number,number],intensity?:number,from:Values,to:Values,
 *   unit?:'layer'|'letters'|'words'|'lines',stagger?:number,order?:'forward'|'reverse',
 *   scatter?:{x?:number,y?:number,rotation?:number,scale?:number,seed?:number},
 *   range?:Object|Object[],
 *   smoothing?:string|[number,number,number,number],smoothingIntensity?:number,
 *   textAnchor?:'layer'|'letters'|'words'|'lines',textClip?:boolean,
 *   anchor?:ResizeAnchor,motionPath?:MotionPath,enabled?:false,
 *   shadowChannels?:Array<'color'|'opacity'|'x'|'y'|'blur'>,fromCurrent?:true,
 *   preset?:{id:string,mode:'in'|'out',parameters:Object,text?:boolean},
 *   discrete?:{type:'instant'}|{type:'blink',count:number}}} TimedAnimation
 *   A preset's identity and controls regenerate its endpoints only on a parameter edit. Old
 *   endpoint-only animations are unchanged. Direct endpoint edits detach the preset controls.
 *   Reveal progress 0..1 clips content along its direction, with softness as a percentage.
 *   Discrete opacity transitions use full-value steps; other values use the selected easing.
 *   `shadowChannels` is a nonempty set of Shadow properties. Omitted or all five retains the
 *   whole-shadow behavior. A partial set composes only those properties onto earlier operations;
 *   color means RGB, opacity means color alpha. Null removes the selector on document input.
 *   `fromCurrent:true` on a custom operation samples earlier enabled operations at its own
 *   staggered start. Stored From endpoints are remembered for explicit mode; they are ignored
 *   during automatic playback. Missing/false/null retains the old endpoint behavior. Resize
 *   anchor shifts, text pivots and path alignment remain additive and are applied only once.
 *   `enabled: false` turns the animation off for playback (see animationEnabled.js); one that is
 *   on has no `enabled` field. Hide and Show operations take it the same way.
 *   `anchor` is only on a Resize (an animation of width or height): the point of the box that
 *   stays in place while the size changes, so x and y move with it (see resizeAnchor.js).
 *   Without it, x and y stay put and the box grows to the right and down.
 *   `intensity` is an integer from 0 to 100 (missing means 50); None and custom curves ignore it.
 *   `smoothing` remaps per-unit delays within their total spread; omitted means linear.
 *   Smooth, Natural, Slow down, Accelerate, None and custom curves are supported. Custom
 *   output is clamped to 0..1. Its own `smoothingIntensity` defaults to 50, independently.
 *   `scatter` offsets each unit's away end (from; to on an out) by seeded amounts up to x, y
 *   pixels, rotation degrees and a scale factor of 1 +/- scale (textTiming.js scatteredAnimation).
 *   `range` times every unit as a Range selector, in place of the stagger (textTiming.js textRangeProgress).
 *   `textAnchor` selects the shaped unit center for rotation/scale independently of `unit`.
 *   `textClip` clips each timing unit to its rest glyph/line cell while following other
 *   animations. Both are ordinary text-only settings; null removes them. Their presence (or
 *   preset.text) opts into independent per-operation unit timing; absent retains legacy timing.
 *   New text presets have `text:true`: relative travel uses the design line height around
 *   saved rest endpoints; other properties remain fixed until edited. Older presets stay exact.
 *   `custom-text` parameters are nullable moveX/moveY (line-height percent), angle (degrees),
 *   scale/opacity (percent of rest), color (hex), and blur (added pixels). One must be enabled.
 * @typedef {{points:Array<{x:number,y:number,in:{x:number,y:number},out:{x:number,y:number}}>,
 *   bezierControls:boolean,alignToPath:boolean,alignmentOffset?:number}} MotionPath
 *   Intermediate points on a custom Move, in the same parent-space box coordinates as its
 *   x/y endpoints. Handles are offsets from each point. Missing paths leave old motion intact.
 *   `alignmentOffset` compensates a reparented coordinate frame; it is normally absent (zero).
 * @typedef {'center'|'top-left'|'top'|'top-right'|'right'|'bottom-right'|'bottom'|'bottom-left'|'left'} ResizeAnchor
 * @typedef {{id:string,name:string,kind:'hide'|'show',start:number,enabled?:false}} VisibilityOperation
 *   An instant Hide or Show at `start` seconds, with no duration, easing or values (see visibilityOps.js).
 * @typedef {{preset:string,duration:number,easing:string|[number,number,number,number],intensity?:number,
 *   unit:'layer'|'letters'|'words'|'lines',stagger:number,order:'forward'|'reverse',distance?:number,
 *   smoothing?:string|[number,number,number,number],smoothingIntensity?:number}} TextEffect
 *   An Out or In effect of a Change text: one of the Out presets (fade-out, shrink-out, blur-out)
 *   or In presets (fade-in, slide-up/down/left/right, grow-in, blur-in, rotate-in). Only a Slide
 *   has `distance` (pixels).
 * @typedef {{id:string,name:string,kind:'change-text',start:number,text:string,overlap:boolean,
 *   out:TextEffect|null,in:TextEffect|null,enabled?:false}} TextChange
 *   On text layers only: at `start` the old string plays `out` and then `text` plays `in`, or
 *   both at once when `overlap` is true; with no effects the swap is instant (see textChange.js).
 * @typedef {{id:string,name:string,kind:'counter',start:number,duration:number,easing:string|[number,number,number,number],intensity?:number,
 *   from:number,to:number,step:number,out:TextEffect|null,in:TextEffect|null,enabled?:false}} Counter
 *   On text layers only: from `start` for `duration` seconds the number in the text counts from
 *   `from` to `to` by `step` (always toward `to`), eased, in the text's own number format; each
 *   step plays `out` on the old number and `in` on the new one (see counter.js).
 * @typedef {{id:string,name:string,kind:'composed',start:number,animations:Animation[],enabled?:false}} ComposedAnimation
 *   Members use relative starts. Nested groups are limited to eight levels. A group's duration
 *   is derived from its members, including text-unit delays; it is not stored. Scaling the
 *   duration scales all member starts, durations, delays, and nested text effects together.
 * @typedef {TimedAnimation|VisibilityOperation|TextChange|Counter|ComposedAnimation|EffectAnimation} Animation
 * @typedef {{id:string,name:string,type:LayerType,parentId:string|null,x:number,y:number,
 *   width:number,height:number,rotation:number,scaleX:number,scaleY:number,skewX:number,opacity:number,
 *   fill:Paint,fillEnabled:boolean,stroke:Paint,strokeWidth:number,strokeAlign:'center'|'inside'|'outside',
 *   radius:number,cornerRadii:number[]|null,inactiveBoxStyles?:Array<'fill'|'stroke'|'corners'>,donut:number,sweep:number,startAngle:number,
 *   spikes:number,starThickness:number,visible:boolean,
 *   locked:boolean,lockAspect:boolean,blur:number,backgroundBlur?:BackgroundBlur,glass?:Glass,
 *   blendMode:string,isMask:boolean,isMaskGroup:boolean,maskInvert?:boolean,maskMode?:'luminance'|'alpha',clipContent:boolean,
 *   shadow:{color:string,x:number,y:number,blur:number}|null,
 *   text:string,fontFamily:string,fontSource:string,fontSize:number,fontWeight:number,fontStyle:'normal'|'italic',
 *   textStyleRanges?:TextStyleRange[],
 *   lineHeight:number,letterSpacing:number,textAlign:'left'|'center'|'right',
 *   verticalAlign:'top'|'middle'|'bottom',textResize:'fixed'|'height'|'width-height',
 *   textCase:'normal'|'upper'|'lower',kerning:boolean,ligatures:boolean,tabularNumbers?:boolean,path:string,
 *   convertedFrom?:'rectangle'|'ellipse'|'star',pathBounds?:{x?:number,y?:number,width:number,height:number},
 *   src:string,mediaStart:number,mediaDuration:number,mediaOffset:number,
 *   mediaFreeze:'none'|'first'|'last'|'both',mediaSourceDuration:number,volume:number,lowpass?:number,morphIn?:number,
 *   mediaSpeed?:number,mediaReverse?:boolean,mediaFrameRate?:number,
 *   mediaInterpolation?:'nearest'|'blend'|'flow',mediaPitch?:'keep'|'follow',
 *   playbackWindows:Array<{start:number,end:number,visibility:'during'|'before'|'after'|'both',hold:boolean}>,
 *   animations:Animation[],componentSceneId?:string,componentStart?:number,componentVisibility?:'during'|'before'|'after'|'both',componentBackgroundEnabled?:boolean}} Layer
 *   `letterSpacing` is a percentage of `fontSize` (letterSpacing.js): 10 on 48 px text adds
 *   4.8 px after each letter. Version 1 documents saved pixels (see documentMigration.js).
 *   `lineHeight` is a multiple of `fontSize` (lineHeight.js): 1.2 on 40 px text puts the lines
 *   48 px apart.
 *   Clip speed (engine/mediaTime.js; optional, left out when normal): `mediaSpeed` (0.05 to 16, on
 *   video, audio and GIF layers) plays the file faster or slower, `mediaReverse` plays it
 *   backwards, `mediaFrameRate` (video and GIF) holds each picture for 1/rate seconds,
 *   `mediaInterpolation` (video) picks how an export draws a time between two file frames, and
 *   `mediaPitch` (video and audio) keeps the sound's pitch or lets it follow the speed. With a
 *   speed, `mediaDuration` is still in scene seconds and `mediaOffset` is still a file time.
 * @typedef {{id:string,name:string,width:number,height:number,duration:number,
 *   background:Paint,backgroundEnabled:boolean,backgroundAnimations:Animation[],isComponent:boolean,layers:Layer[],
 *   componentPlayback?:'content'|'scene',bulkVariant?:{baseSceneId:string,key:string,instanceId:string}}} Scene
 *   `componentPlayback` defaults to content. A selection extracted into a component uses scene:
 *   its instance clock plays at least the scene duration, including post-Play media visibility.
 * @typedef {{id:string,name:string,kind:'effect',effect:string,start:number,duration:number,
 *   easing:string|[number,number,number,number],intensity?:number,from?:Object,to:Object,
 *   keepStill?:'off'|'start'|'end'|'both',enabled?:false}} EffectAnimation
 *   Catalog-defined typed parameters are layer-local. Only ranged effects accept Keep still;
 *   their held clock freezes at the endpoint. Value effects sample an omitted initial value
 *   from earlier operations of the same effect, then hold their target. See effects/catalog.js.
 * @typedef {{version:6,id:string,name:string,scenes:Scene[]}} MotionDocument
 */
// Version 2 saves letter spacing as a percentage of the font size. Version 3 adds scene
// background paint, visibility and Color animations. Version 4 enables media/group box styles;
// inactiveBoxStyles preserves previously stored but undrawn values until that style is edited.
// documentMigration.js upgrades older files without changing their appearance.
// Version 5 adds Composed animation groups; existing operations keep their values and clocks.
// Version 6 adds catalog-defined effect operations. Earlier document values remain unchanged;
// older builds reject the new version instead of dropping effects during a save or export.
export const DOCUMENT_VERSION = 6;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Longest scene, and latest time an animation may end, in seconds: ten minutes, long enough for
 * a whole song (engine/timeLimits.js has the editing limits built on it). It lives here, in a file
 * that imports nothing, so model.js, playback.js and the effect code can all share it.
 */
export const MAX_TIME = 600;
/** Longest media file, in seconds: offsets and file times address a point inside a file up to a day long. */
export const MAX_MEDIA_SECONDS = 86_400;
