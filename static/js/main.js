/* ============================
   FloorPlan Demo – main.js
   ============================ */
   const $ = q => document.querySelector(q);
   const colorFor = n =>
     n === "wall" ? "#2563eb" :
     n === "window" ? "#16a34a" :
     n === "door" ? "#dc2626" : "#f59e0b";
   
   const basePalette = [
     "#38bdf8", "#f97316", "#6d28d9", "#f9a8d4", "#22c55e", "#a3e635",
     "#f59e0b", "#0ea5e9", "#ef4444", "#8b5cf6", "#14b8a6", "#facc15",
     "#84cc16", "#eab308", "#06b6d4", "#d946ef", "#fb7185", "#93c5fd"
   ];
   const roomColor = { living:"#38bdf8", bedroom:"#6d28d9", kitchen:"#0ea5e9", bathroom:"#f97316", corridor:"#a3e635" };
   let paletteIdx = 0;
   function getRoomColor(room){
     if (!room) return "#94a3b8";
     if (roomColor[room]) return roomColor[room];
     const col = basePalette[paletteIdx % basePalette.length];
     paletteIdx += 1; roomColor[room] = col; return col;
   }
   
   /* ---------- DOM refs ---------- */
   const dropzone = $("#dropzone"),
         filesInput = $("#files"),
         ex1Btn = $("#ex1"),
         ex2Btn = $("#ex2"),
         thumbsWrap = $("#thumbs"),
         runBtn = $("#run"),
         gptBtn = $("#askgpt"),
         buildBtn = $("#build3d"),
         walkBtn = $("#walk"),
         fsBtn   = $("#fullscreen"),
         openMapBtn = $("#openMap"),
         floorSel = $("#floorSelect"),
         floorHInput = $("#floorHeight"),
         slabInput = $("#slabThick"),
         canvas = $("#canvas"),
         ctx = canvas.getContext("2d"),
         out = $("#out"),
         meta = $("#meta"),
         warn = $("#three-warn"),
         roomLegend = $("#roomLegend"),
         threeWrap = $("#three-wrap");
   
   /* ---------- state ---------- */
   let floors = []; // [{id, file, name, image, width, height, result, improved, thumbUrl}]
   let currentOverlayIndex = 0;
   
   /* ==========================================================
      DRAG & DROP  +  File ingestion + EXAMPLES
      ========================================================== */
   function isImageFile(f){ return f && (f.type?.startsWith("image/") || f.name?.match(/\.(png|jpg|jpeg)$/i)); }
   
   function readAsDataURL(file){
     return new Promise((res, rej) => {
       const r = new FileReader();
       r.onload = e => res(e.target.result);
       r.onerror = rej;
       r.readAsDataURL(file);
     });
   }
   function loadImage(src){
     return new Promise((res, rej) => {
       const img = new Image();
       img.onload = () => res(img);
       img.onerror = rej;
       img.src = src;
     });
   }
   
   async function ingestFiles(fileList){
     floors = [];
     [gptBtn, buildBtn, walkBtn, fsBtn, openMapBtn].forEach(b => b.disabled = true);
     floorSel.innerHTML = "";
     thumbsWrap.innerHTML = "";
   
     const files = Array.from(fileList || []).filter(isImageFile);
     if (!files.length) return;
   
     for (let i = 0; i < files.length; i++) {
       const file = files[i];
       const dataURL = await readAsDataURL(file);
       const img = await loadImage(dataURL);
       const thumbUrl = dataURL; // can reuse for thumb
       floors.push({
         id: i, file, name: file.name || `Floor ${i+1}`,
         image: img, width: img.naturalWidth, height: img.naturalHeight,
         thumbUrl, result: null, improved: null
       });
     }
     updateFloorSelect();
     renderThumbs();
     currentOverlayIndex = 0;
     drawOnlyImage(currentOverlayIndex);
   }
   
   async function ingestExample(names){
     // Fetch example images from server, create File objects, then use ingestFiles
     const files = [];
     for (const name of names) {
       const resp = await fetch(`/examples/${encodeURIComponent(name)}`);
       if (!resp.ok) { alert(`Failed to load example: ${name}`); return; }
       const blob = await resp.blob();
       const file = new File([blob], name, { type: blob.type || "image/png" });
       files.push(file);
     }
     await ingestFiles(files);
   }
   
   /* input picker */
   filesInput.addEventListener("change", async () => ingestFiles(filesInput.files));
   
   /* drag & drop UX */
   ["dragenter","dragover"].forEach(evt =>
     dropzone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add("hover"); })
   );
   ["dragleave","dragend","drop"].forEach(evt =>
     dropzone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("hover"); })
   );
   dropzone.addEventListener("drop", e => {
     const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files).filter(isImageFile) : [];
     ingestFiles(files);
   });
   dropzone.addEventListener("click", () => filesInput.click());
   
   /* examples */
   ex1Btn.addEventListener("click", async ()=>{
     // Example 1: 3 floors
     const names = ["ex1-floor1.png","ex1-floor2.png","ex1-floor3.png"];
     await ingestExample(names);
   });
   ex2Btn.addEventListener("click", async ()=>{
     // Example 2: 1 floor (as provided)
     const names = ["ex2-floor1.png"];
     await ingestExample(names);
   });
   
   /* thumbnails */
   function renderThumbs(){
     thumbsWrap.innerHTML = "";
     floors.forEach((f, i) => {
       const div = document.createElement("div");
       div.className = "thumb" + (i === currentOverlayIndex ? " active" : "");
       div.title = f.name;
       div.addEventListener("click", () => {
         currentOverlayIndex = i;
         floorSel.value = String(i);
         renderThumbs();
         const show = floors[currentOverlayIndex];
         if (show && (show.improved || show.result)) {
           render2D(show.improved || show.result, !!show.improved);
         } else {
           drawOnlyImage(currentOverlayIndex);
         }
       });
   
       const img = document.createElement("img");
       img.src = f.thumbUrl;
       const badge = document.createElement("div");
       badge.className = "badge";
       badge.textContent = `Floor ${i+1}`;
       div.appendChild(img);
       div.appendChild(badge);
       thumbsWrap.appendChild(div);
     });
   }
   
   /* ==========================================================
      Floor select + 2D rendering
      ========================================================== */
   function updateFloorSelect(){
     floorSel.innerHTML = "";
     floors.forEach((f, i) => {
       const opt = document.createElement("option");
       opt.value = i; opt.textContent = `${i+1}: ${f.name}`;
       floorSel.appendChild(opt);
     });
     floorSel.disabled = floors.length <= 1;
   }
   floorSel.addEventListener("change", () => {
     currentOverlayIndex = Number(floorSel.value) || 0;
     renderThumbs();
     const f = floors[currentOverlayIndex];
     if (f && (f.improved || f.result)) render2D(f.improved || f.result, !!f.improved);
     else drawOnlyImage(currentOverlayIndex);
   });
   function drawOnlyImage(idx){
     const f = floors[idx];
     if (!f || !f.image) return;
     canvas.width = f.image.naturalWidth;
     canvas.height = f.image.naturalHeight;
     ctx.drawImage(f.image, 0, 0);
     meta.textContent = `Image: ${f.width}×${f.height}`;
     out.textContent = "{}";
     roomLegend.innerHTML = "";
   }
   
   function render2D(data, useRooms=false){
     out.textContent = JSON.stringify(data, null, 2);
   
     const f = floors[currentOverlayIndex];
     if (f && f.image) {
       canvas.width = f.image.naturalWidth;
       canvas.height = f.image.naturalHeight;
       ctx.drawImage(f.image, 0, 0);
     }
   
     roomLegend.innerHTML = "";
     const w = data.Width ?? (f ? f.width : canvas.width);
     const h = data.Height ?? (f ? f.height : canvas.height);
     const sx = canvas.width / Math.max(1, w);
     const sy = canvas.height / Math.max(1, h);
   
     const cache = new Set();
     const pts = data.points || [];
     const cls = data.classes || [];
   
     pts.forEach((p, i) => {
       const room = p.room;
       const kind = (cls[i] && cls[i].name) ? cls[i].name : "wall";
       const col = (useRooms && room) ? getRoomColor(room) : colorFor(kind);
   
       if (useRooms && room && !cache.has(room)) { cache.add(room); addLegend(room, col); }
   
       const x = p.x1 * sx, y = p.y1 * sy, ww = (p.x2 - p.x1) * sx, hh = (p.y2 - p.y1) * sy;
       ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.strokeRect(x, y, ww, hh);
     });
   
     const avg = (typeof data.averageDoor === "number" && !isNaN(data.averageDoor)) ? data.averageDoor.toFixed(2) : "—";
     meta.textContent = `Image: ${w}×${h} • doorAvg=${avg}`;
   }
   function addLegend(name, col){
     const tag = document.createElement("span");
     tag.className = "tag";
     tag.innerHTML = `<span class="dot" style="background:${col}"></span>${name}`;
     roomLegend.appendChild(tag);
   }
   
   /* ==========================================================
      Inference / GPT buttons
      ========================================================== */
   runBtn.addEventListener("click", async () => {
     const sel = floors;
     if (!sel.length) { alert("Pick one or more images"); return; }
   
     runBtn.disabled = true;
     out.textContent = "Running…";
   
     try {
       for (let i = 0; i < floors.length; i++) {
         const f = floors[i];
         const fd = new FormData(); fd.append("image", f.file);
         const r = await fetch("/predict", { method: "POST", body: fd });
         if (!r.ok) throw new Error(await r.text());
         const data = await r.json();
         f.result = data;
       }
       const show = floors[currentOverlayIndex];
       if (show && show.result) render2D(show.result);
       [gptBtn, buildBtn, walkBtn, fsBtn, openMapBtn].forEach(b => b.disabled = false);
     } catch (e) {
       out.textContent = "Err " + e.message;
     } finally {
       runBtn.disabled = false;
     }
   });
   
   gptBtn.addEventListener("click", async () => {
     const haveAll = floors.every(f => !!f.result);
     if (!haveAll) { alert("Run inference first for all floors"); return; }
   
     gptBtn.disabled = true; gptBtn.textContent = "GPT…";
     try {
       for (let i = 0; i < floors.length; i++) {
         const f = floors[i];
         const fd = new FormData();
         fd.append("image", f.file);
         fd.append("json", JSON.stringify(f.result));
         const r = await fetch("http://localhost:5100/improve", { method: "POST", body: fd });
         if (!r.ok) throw new Error(await r.text());
         f.improved = await r.json();
         f.improved.Width  = f.improved.Width  ?? f.result.Width  ?? f.width;
         f.improved.Height = f.improved.Height ?? f.result.Height ?? f.height;
       }
       const show = floors[currentOverlayIndex];
       if (show && show.improved) render2D(show.improved, true);
     } catch (e) {
       alert("GPT err: " + e.message);
     } finally {
       gptBtn.disabled = false; gptBtn.textContent = "Ask GPT";
     }
   });
   
   /* =================================================================
      3D  (Three.js + Controls) – use builder output ONLY
      ================================================================= */
   let scene, camera, renderer, controls, rafId, walkControls=null, isWalking=false;
   const colliders = [];
   const rayTargets = [];
   const eyeHeight = 1.6;
   const move = { f:false, b:false, l:false, r:false, fast:false, slow:false };
   let lastTime = performance.now();
   let currentHouse = null;
   let sceneryGroup = null;  // ground + trees
   
   function isFullscreen(){ return document.fullscreenElement === threeWrap; }
   async function toggleFullscreen(){ try{ !isFullscreen() ? await threeWrap.requestFullscreen() : await document.exitFullscreen(); }catch(e){} }
   function updateRendererSize(){
     if(!renderer || !camera) return;
     const w = threeWrap.clientWidth || 800, h = threeWrap.clientHeight || 600;
     camera.aspect = w / Math.max(1,h);
     camera.updateProjectionMatrix();
     renderer.setSize(w, h);
   }
   function disposeGroup(root){
     if (!root) return;
     root.traverse(o=>{
       if (o.isMesh) {
         o.geometry?.dispose?.();
         if (o.material) {
           if (Array.isArray(o.material)) o.material.forEach(m=>m.dispose?.());
           else o.material.dispose?.();
         }
       }
     });
   }
   
   function initThree(){
     if (!window.THREE || !window.OrbitControls) { warn.style.display="block"; return false; }
     warn.style.display = window.PointerLockControls ? "none" : "block";
   
     if (rafId) cancelAnimationFrame(rafId);
     if (renderer) { renderer.dispose(); threeWrap.innerHTML = ""; }
   
     scene = new THREE.Scene();
     scene.background = new THREE.Color(0xdbeafe);
     scene.fog = new THREE.Fog(0xdbeafe, 30, 220);
   
     camera = new THREE.PerspectiveCamera(60, threeWrap.clientWidth/threeWrap.clientHeight, 0.01, 2000);
     camera.position.set(6, eyeHeight, 10);
   
     renderer = new THREE.WebGLRenderer({ antialias:true });
     renderer.shadowMap.enabled = true;
     renderer.shadowMap.type = THREE.PCFSoftShadowMap;
     updateRendererSize();
     threeWrap.appendChild(renderer.domElement);
   
     controls = new window.OrbitControls(camera, renderer.domElement);
     controls.enableDamping = true;
   
     walkControls = window.PointerLockControls ? new window.PointerLockControls(camera, renderer.domElement) : null;
   
     // Lights
     const hemi = new THREE.HemisphereLight(0xffffff,0x89b7a7,.85);
     scene.add(hemi);
   
     const sun = new THREE.DirectionalLight(0xffffff, .9);
     sun.position.set(12, 22, 8);
     sun.castShadow = true;
     sun.shadow.camera.near = 0.1;
     sun.shadow.camera.far = 200;
     sun.shadow.mapSize.set(2048, 2048);
     scene.add(sun);
   
     // (Keep the grid faint, below ground plane)
     const grid = new THREE.GridHelper(300, 200, 0xb6c3d1, 0xe2e8f0);
     grid.position.y = -0.03;
     scene.add(grid);
   
     window.addEventListener("resize", updateRendererSize);
     document.addEventListener("fullscreenchange", updateRendererSize);
   
     // double-click to teleport
     const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
     renderer.domElement.addEventListener("dblclick",(ev)=>{
       if (!rayTargets.length) return;
       const rect = renderer.domElement.getBoundingClientRect();
       mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
       mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
       raycaster.setFromCamera(mouse, camera);
       const hits = raycaster.intersectObjects(rayTargets, true);
       if (hits && hits.length) {
         const p = hits[0].point.clone();
         if (walkControls) {
           teleportToPoint(p);
           if (!isWalking) enterWalkMode();
         } else {
           camera.position.set(p.x, p.y + eyeHeight, p.z + 1.0);
           controls.target.set(p.x, p.y, p.z); controls.update();
         }
       }
     });
   
     // render loop
     const loop = ()=>{
       rafId = requestAnimationFrame(loop);
       const now = performance.now(), delta = (now-lastTime)/1000; lastTime = now;
       isWalking ? updateWalk(delta) : controls.update();
       renderer.render(scene,camera);
     };
     lastTime = performance.now(); loop();
     return true;
   }
   
   function enterWalkMode(){ if(!walkControls) return;
     controls.enabled=false; walkControls.lock(); isWalking=true;
     walkBtn.textContent="Exit Walk";
     document.addEventListener("keydown", onKeyDown);
     document.addEventListener("keyup", onKeyUp);
   }
   function exitWalkMode(){ if(!walkControls) return;
     isWalking=false; walkControls.unlock(); controls.enabled=true;
     walkBtn.textContent="Walk Mode";
     document.removeEventListener("keydown", onKeyDown);
     document.removeEventListener("keyup", onKeyUp);
   }
   function onKeyDown(e){
     switch(e.code){
       case "KeyW": case "ArrowUp":    move.f = true; break;
       case "KeyS": case "ArrowDown":  move.b = true; break;
       case "KeyA": case "ArrowLeft":  move.l = true; break;
       case "KeyD": case "ArrowRight": move.r = true; break;
       case "ShiftLeft": case "ShiftRight": move.fast = true; break;
       case "ControlLeft": case "ControlRight": move.slow = true; break;
       case "KeyF": toggleFullscreen(); break;
       case "KeyX": toggleXray(); break;       // X-ray walls
     }
   }
   function onKeyUp(e){
     switch(e.code){
       case "KeyW": case "ArrowUp":    move.f = false; break;
       case "KeyS": case "ArrowDown":  move.b = false; break;
       case "KeyA": case "ArrowLeft":  move.l = false; break;
       case "KeyD": case "ArrowRight": move.r = false; break;
       case "ShiftLeft": case "ShiftRight": move.fast = false; break;
       case "ControlLeft": case "ControlRight": move.slow = false; break;
     }
   }
   function updateWalk(delta){
     const obj = walkControls.getObject();
     const forward = new THREE.Vector3(); walkControls.getDirection(forward);
     forward.y = 0; forward.normalize();
     const right = new THREE.Vector3().copy(forward).cross(new THREE.Vector3(0,1,0));
   
     const sp = move.fast ? 3.0 : (move.slow ? 0.75 : 1.5);
     const mv = new THREE.Vector3();
     if (mv.lengthSq() > 0) obj.position.add(mv);
     if (move.f) mv.add(forward);
     if (move.b) mv.addScaledVector(forward, -1);
     if (move.r) mv.add(right);
     if (move.l) mv.addScaledVector(right, -1);
     if (mv.lengthSq() > 0) {
       mv.normalize().multiplyScalar(sp * delta);
       obj.position.add(mv);
     }
   }
   function teleportToPoint(worldPoint){
     if (!walkControls) return;
     const obj = walkControls.getObject();
     const target = worldPoint.clone(); target.y = worldPoint.y + eyeHeight;
     obj.position.copy(target);
   }
   
   /* ----- X-ray walls ----- */
   let xray = false;
   function toggleXray() {
     if (!currentHouse) return;
     xray = !xray;
     currentHouse.traverse(o => {
       if (o.isMesh && o.userData.kind === 'wall' && o.material) {
         o.material.transparent = xray;
         o.material.opacity = xray ? 0.35 : 1.0;
         o.material.depthWrite = !xray;
         o.material.needsUpdate = true;
       }
     });
     console.log('[3D] X-ray walls:', xray);
   }
   
   /* ----- Scenery (land + trees) ----- */
   function createTreeMesh(){
     const g = new THREE.Group();
   
     const trunk = new THREE.Mesh(
       new THREE.CylinderGeometry(0.06, 0.08, 0.8, 8),
       new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 })
     );
     trunk.position.y = 0.4; trunk.castShadow = true;
     g.add(trunk);
   
     const foliage = new THREE.Mesh(
       new THREE.ConeGeometry(0.6, 1.2, 10),
       new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8 })
     );
     foliage.position.y = 1.4; foliage.castShadow = true;
     g.add(foliage);
   
     return g;
   }
   
   function buildScenery(bbox){
     if (sceneryGroup){ scene.remove(sceneryGroup); disposeGroup(sceneryGroup); }
     sceneryGroup = new THREE.Group();
   
     const size = bbox.getSize(new THREE.Vector3());
     const center = bbox.getCenter(new THREE.Vector3());
   
     const span = Math.max(size.x, size.z);
     const plotW = Math.max(30, span * 5);
     const plotD = Math.max(30, span * 5);
   
     const ground = new THREE.Mesh(
       new THREE.PlaneGeometry(plotW, plotD),
       new THREE.MeshStandardMaterial({ color: 0xa7f3d0, roughness: 1 })
     );
     ground.rotation.x = -Math.PI/2;
     ground.position.set(center.x, -0.02, center.z);
     ground.receiveShadow = true;
     sceneryGroup.add(ground);
   
     const radius = Math.max(span * 0.8, 8);
     const trees = new THREE.Group();
     const count = 36;
     for (let i=0; i<count; i++){
       const a = (i / count) * Math.PI * 2;
       const r = radius + (Math.random()*3 + 2);
       const x = center.x + Math.cos(a) * r;
       const z = center.z + Math.sin(a) * r;
   
       const t = createTreeMesh();
       t.position.set(x, 0, z);
       t.rotation.y = Math.random() * Math.PI * 2;
       t.scale.setScalar(0.8 + Math.random()*0.6);
       trees.add(t);
     }
     sceneryGroup.add(trees);
   
     scene.add(sceneryGroup);
   }
   
   /* ----- Build 3-D from builder ONLY ----- */
   function build3DStack(){
     if (!floors.length) { alert("Load floors first"); return; }
     if (!initThree()) return;
   
     const payload = floors.map(f => f.improved || f.result).filter(Boolean);
     window.__FLOORS__ = payload;              // also used by /map
     localStorage.setItem("floors_payload", JSON.stringify(payload));
   
     if (currentHouse) { scene.remove(currentHouse); disposeGroup(currentHouse); currentHouse = null; }
     rayTargets.length = 0; colliders.length = 0;
   
     const opts = {
       unitPerPx: 0.01,
       floorHeight: parseFloat(floorHInput.value) || 3.0,
       slab: parseFloat(slabInput.value) || 0.30,
       sill: 1.0,
       windowHeight: 1.2,
       useRoomColors: true,
       addPerimeterIfSparse: true,
       perimeterThickness: 0.18,
       perimeterCoverage: 0.30,
       debug: false
     };
     const built = window.HouseBuilder.buildGroupFromFloors(payload, opts);
     currentHouse = built.group;
     scene.add(currentHouse);
     rayTargets.push(...built.floorMeshes);
     colliders.push(...built.colliders);
   
     currentHouse.traverse(o => {
       if (o.isMesh) {
         o.castShadow = (o.userData.kind !== 'window');
         o.receiveShadow = true;
       }
     });
   
     let cw=0, cd=0, cwins=0;
     currentHouse.traverse(o=>{
       if (!o.isMesh) return;
       if (o.userData.kind === 'wall') cw++;
       if (o.userData.kind === 'door') cd++;
       if (o.userData.kind === 'window') cwins++;
     });
     console.log('[3D] meshes → walls:', cw, 'doors:', cd, 'windows:', cwins);
   
     const bbox = new THREE.Box3().setFromObject(currentHouse);
     const size = bbox.getSize(new THREE.Vector3());
     const center = bbox.getCenter(new THREE.Vector3());
     const diag = size.length();
     camera.position.set(center.x + diag*0.5, Math.max(2.0, built.totalHeight*0.9), center.z + diag*0.9);
     controls.target.copy(center); controls.update();
   
     buildScenery(bbox);
   }
   
   /* ---------- Buttons ---------- */
   buildBtn.addEventListener("click", () => build3DStack());
   walkBtn.addEventListener("click", () => {
     if (!scene) { alert("Build the 3-D first"); return; }
     if (!window.PointerLockControls) { alert("Walk mode unavailable"); return; }
     isWalking ? exitWalkMode() : enterWalkMode();
   });
   fsBtn.addEventListener("click", () => {
     if (!scene) { alert("Build the 3-D first"); return; }
     toggleFullscreen(); setTimeout(updateRendererSize, 50);
   });
   openMapBtn.addEventListener("click", () => {
     if (!window.__FLOORS__?.length) {
       const payload = floors.map(f => f.improved || f.result).filter(Boolean);
       localStorage.setItem("floors_payload", JSON.stringify(payload));
     }
     window.open("/map", "_blank");
   });
   