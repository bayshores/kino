import test from "node:test";
import assert from "node:assert/strict";
import {Resvg} from "@resvg/resvg-js";
import {createDocument,createScene,createLayer,parseDocument} from "../engine/model.js";
import {expandComponents,createComponentInstance} from "../engine/linkedComponents.js";
import {renderSceneSvg} from "../engine/render.js";
import {exportScene} from "./export.mjs";

test("linked component morphs render actual intermediate pixels and export current source edits",async()=>{
  const from="M0 0L20 0L0 20Z",to="M0 0L60 0L0 44Z";
  const source=createScene({id:"source",isComponent:true,width:64,height:48,duration:1,background:"#00000000",layers:[createLayer("path",{id:"triangle",x:0,y:0,width:64,height:48,pathBounds:{width:64,height:48},fill:"#ff0000",path:from,animations:[{id:"morph",name:"Morph",kind:"custom",start:0,duration:1,easing:"linear",from:{path:from},to:{path:to}}]})]});
  const target=createScene({id:"target",width:128,height:48,duration:1,background:"#00000000",layers:[createComponentInstance(source,{x:32,y:0})]});
  const document=parseDocument(createDocument({scenes:[source,target]}));
  const scene=expandComponents(document,target.id);
  const pixel=(time,x,y)=>{
    const raster=new Resvg(renderSceneSvg(scene,time),{font:{loadSystemFonts:false}}).render();
    return [...raster.pixels.subarray((y*128+x)*4,(y*128+x)*4+4)];
  };
  assert.equal(pixel(0,60,8)[3],0);
  assert.deepEqual(pixel(.5,60,8),[255,0,0,255]);
  assert.deepEqual(pixel(1,60,8),[255,0,0,255]);
  const original=await exportScene(scene,{format:"png",width:128,height:48,time:.5});
  assert.equal(original.mime,"image/png");
  document.scenes[0].layers[0].fill="#00ff00";
  const edited=await exportScene(expandComponents(document,target.id),{format:"png",width:128,height:48,time:.5});
  assert.notDeepEqual(edited.buffer,original.buffer);
  assert.equal(document.scenes[1].layers.length,1);
});
