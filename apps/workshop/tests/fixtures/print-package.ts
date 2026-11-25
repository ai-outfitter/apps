import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

export function stl(peak = 1) {
  const points = [[0,0,0],[2,0,0],[0,3,0],[peak,1,1]];
  const data = Buffer.alloc(84+2*50);
  data.writeUInt32LE(2,80);
  for (const [index,face] of [[0,1,3],[0,3,2]].entries()) {
    let offset=84+50*index+12;
    for (const vertex of face) for (const value of points[vertex]) {
      data.writeFloatLE(value,offset);
      offset+=4;
    }
  }
  return data;
}
export const hash = (value:Uint8Array) => createHash("sha256").update(value).digest("hex");
export const source = stl();
const sha256 = hash(source);
export const itemId = "11111111-1111-4111-8111-111111111111";
export const members = [{itemId,sha256,quantity:2}];
export const parts = [{itemId,sha256,fileName:"bracket.stl",quantity:2}];
export const plates = [{index:1,name:"Plate 1",members}];
export const loadSource = async () => source;
const settings = strToU8(JSON.stringify({printer_model:"Bambu Lab P2S",filament_settings_id:["Generic ASA"]}));
export const report = strToU8(JSON.stringify({return_code:0,sliced_plates:[{
  id:1,total_predication:131.5,warning_message:"",filaments:[{total_used_g:12.453}],
  objects:[{name:"bracket.stl"},{name:"bracket.stl"}],
}]}));
const nativeSummary = strToU8(`<config><header><header_item key="X-BBL-Client-Version" value="02.08.00.50"/></header><plate>
  <metadata key="index" value="1"/>
  <metadata key="prediction" value="131"/>
  <metadata key="weight" value="12.45"/>
  <object identify_id="11" name="bracket.stl" skipped="false" />
  <object identify_id="12" name="bracket.stl" skipped="false" />
</plate></config>`);
export const nativePlateMap = strToU8(`<config><plate>
  <metadata key="plater_id" value="1"/>
  <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
  ${[0,1].map(instance=>`<model_instance><metadata key="object_id" value="2"/>
    <metadata key="instance_id" value="${instance}"/><metadata key="identify_id" value="${11+instance}"/>
  </model_instance>`).join("")}
</plate></config>`);
const relocatedModel = strToU8(`<model unit="millimeter"><resources><object id="1"><mesh>
  <vertices><vertex x="-20" y="-30" z="-5"/><vertex x="-18" y="-30" z="-5"/>
    <vertex x="-20" y="-27" z="-5"/><vertex x="-19" y="-29" z="-4"/></vertices>
  <triangles><triangle v1="3" v2="2" v3="0"/><triangle v1="1" v2="3" v3="0"/></triangles>
</mesh></object></resources></model>`);
const model = (rotation:string) => strToU8(`<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources><object id="2"><components><component p:path="/3D/Objects/part.model" objectid="1"
    transform="1 0 0 0 1 0 0 0 1 20 30 5"/></components></object></resources>
  <build><item objectid="2"/><item objectid="2" transform="${rotation}"/></build></model>`);
export const nativeRotation = "0 -1 0 1 0 0 0 0 1 20 30 0";
export const archive = (toolpath = true, rotation = nativeRotation, mapping=nativePlateMap) => zipSync({
  "Metadata/project_settings.config":settings,
  "Metadata/slice_info.config":nativeSummary,
  "Metadata/model_settings.config":mapping,
  "3D/3dmodel.model":model(rotation),
  "3D/Objects/part.model":relocatedModel,
  ...(toolpath && {"Metadata/plate_1.gcode":strToU8("G1 X8 E1")}),
});
