'use strict';

import * as THREE from 'https://threejsfundamentals.org/threejs/resources/threejs/r127/build/three.module.js';

/**
 * GPU 기반 피킹 구현하기
 * 
 * 투명한 구멍이 뚫린 재질을 맵핑한 큐브들 사이에서 피킹을 구현할 때는
 * 광선이 투명한 구멍을 지나쳐야 하는데, 그렇지 않고 투명한 구명을 지나갈 때 해당 큐브와 '교차하는 것으로 인식' 하는 문제가 있음.
 * 즉, 광선이 투명한 구멍을 지나쳤을 뿐인데 그거를 교차한 오브젝트로 인식해서 피킹이 된다는 게 문제임.
 * 
 * 이거를 해결하려면 조금 더 복잡한 GPU 피킹을 구현해야 함.
 * GPU 피킹은 각 큐브메쉬들을 동일하게 2개의 씬에 각각 렌더링해줘야 함.
 * 하나는 우리가 원래 화면에 렌더링하는 씬이고, 다른 하나는 고유의 색상값으로 같은 위치에 큐브들을 렌더링해놓은 씬(이하 피킹용 씬).
 * 이 때, 고유의 색상값은 Color 객체에 '십진수 정수값'을 전달해서 지정해주고, 해당 십진수 정수값(이하 id 색상값)을 key, 색상값을 할당받은 큐브 메쉬와 매칭되는 원래 큐브를 value로
 * idToObject라는 객체에 데이터쌍으로 각각 저장해 줌.
 * 
 * 이 방법에서는 Raycaster를 사용하지 않음. 
 * 
 * 1. 대신 렌더 타겟을 생성하고, 
 * 2. 렌더러의 활성 렌더 대상을 렌더 타겟으로 변경한 뒤,
 * 3. 피킹용 씬을 카메라를 전달해서 매 프레임마다 렌더해 줌.
 * 
 * 이때, 카메라의 위치 및 사이즈를 setViewOffset을 이용해서
 * 현재 mousemove의 마우스 포인터 지점 아래에 1픽셀 만큼으로 지정함.
 * 즉, mousemove 이벤트의 좌표값 지점을 1 * 1 사이즈의 카메라로 피킹용 씬을 찍어주는 짓을 매 프레임마다 반복하는거임.
 * 
 * 이 렌더타겟을 원래의 씬에서 텍스처로 사용한다거나 하는건 아니고,
 * readRenderTargetPixels 메서드를 이용하여 해당 렌더타겟안의 피킹용 씬의 1 * 1 지점의 픽셀 데이터값을 받아옴.
 * 그거를 Uint8Array(4) 형식화 배열에다가 복사해서 넣어줌. 왜 배열길이가 4일까? 픽셀 데이터는 r, g, b, a 총 4개의 데이터값이 들어있으니까!
 * 그리고 왜 형식화배열을 사용할까? readRenderTargetPixels 메서드가 Uint8Array만 받기 떄문임.
 * 
 * 그럼 이제 Uint8Array에는 이진수 데이터로 r, g, b, a값이 저장되어 있으니 비트연산자를 이용해서 r, g, b값을 십진수로 변환하고,
 * 그 십진수와 동일한 key값을 갖는 idToObject 객체 안의 큐브 메쉬를 pickedObject에 할당하여 이 녀석의 emissive 컬러값을 타임스탬프값에 따라 빨강/노랑으로 빛나게 해줌.
 * 
 * 결국 핵심은 광선을 쏘는 게 아니라, 피킹용 씬에서 마우스 현재 좌표값 바로 아래에 있는 지점의 픽셀 데이터로 큐브 메쉬들을 구분한다고 보면 됨.
 */

function main() {
  // create WebGLRenderer
  const canvas = document.querySelector('#canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas
  });

  // create camera
  const fov = 60;
  const aspect = 2;
  const near = 0.1;
  const far = 200;
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.z = 30;

  // gpu 피킹을 구현하려면 화면에 실제로 렌더하는 씬, 렌더 타겟으로 사용할 피킹용 씬이 모두 필요함. 
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('white');
  const pickingScene = new THREE.Scene();
  pickingScene.background = new THREE.Color(0); // 피킹용 씬의 배경색은 'black'으로 지정함.
  // Color 객체에 십진수 정수값을 전달하면, 이거를 자동으로 16진수로 변환하여 색상값으로 할당해주는 것 같음. 0 = 0x000000과 동일하니까 검정색이 할당되겠지

  // 카메라를 봉(pole) 오브젝트에 추가해서 봉을 회전시키면 카메라가 장면 주위를 공전할 수 있도록 함.
  const cameraPole = new THREE.Object3D();
  scene.add(cameraPole);
  cameraPole.add(camera);

  // create directionalLight(직사광)
  {
    const color = 0xFFFFFF;
    const intensity = 1;
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(-1, 2, 4);
    camera.add(light); // 카메라에 조명을 자식노드로 추가해 카메라가 장면 주위를 공전할 때마다 조명이 따라다니면서 카메라 위치에서 빛을 쏴주도록 함.
  }

  // create boxGeometry
  const boxWidth = 1;
  const boxHeight = 1;
  const boxDepth = 1;
  const geometry = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);

  // 최솟값과 최댓값을 인자로 넘겨주면 그 사이의 랜덤값을 리턴해주는 함수
  function random(min, max) {
    if (max === undefined) {
      max = min;
      min = 0;
    }

    return min + (max - min) * Math.random(); // min ~ max 사이의 랜덤값 리턴
  }

  // 큐브 메쉬의 퐁-머티리얼을 생성할 때 color에 할당할 색상값을 hsl로 리턴해 줌. 이 때 hue, saturation값을 랜덤으로 리턴받아 옴.
  function randomColor() {
    return `hsl(${random(360) | 0}, ${random(50, 100) | 0}%, 50%)` // hue값은 0 ~ 360 사이의 정수, saturation값은 50 ~ 100 사이의 정수가 들어가겠군
  }

  // 가운데 투명한 구멍이 뚫린 텍스처를 로드함
  const loader = new THREE.TextureLoader();
  const texture = loader.load('./image/frame.png');

  const idToObject = {}; // {id 색상값: 해당 색상값이 할당된 피킹용 큐브와 매칭되는 원래 큐브} 형태로 데이터쌍을 맵핑해 둘 객체를 만듦.
  const numObjects = 100; // 랜덤으로 생성할 큐브 메쉬 개수
  for (let i = 0; i < numObjects; i++) {
    // 각 피킹용 큐브에 색상값으로 넣어줄 십진수 정수값인 id 색상값.
    // 근데 왜 1부터 시작하지? 왜 0은 없지? 위에서 피킹용 씬 배경색을 new Color(0), 즉 black으로 지정해줬으니까. 배경, 투명한 부분은 모두 black으로 통일하고 각 큐브의 텍스처 부분만 고유의 id 색상값을 넣어줘야 피킹할 때 구분이 가능하겠지
    const id = i + 1;
    // 랜덤으로 색상값을 할당받은 퐁-머티리얼을 100개 생성함.
    const material = new THREE.MeshPhongMaterial({
      color: randomColor(),
      map: texture, // 퐁-머티리얼에 텍스처를 할당하고
      transparent: true, // transparent 속성을 활성화해주고
      alphaTest: 0.1, // png 텍스처 자체에 이미 각 부분의 투명도가 별개로 지정되어 있으므로, 텍스처에서 투명도가 0.1보다 낮은 부분의 픽셀만 렌더해주지 않도록 지정해주기만 하면 됨. 
      side: THREE.DoubleSide, // 가운데가 투명하게 뚫린 텍스쳐니까 안쪽 면도 보일 수 있어야 함. 따라서 양면 렌더링을 지정해 줌.
    });

    // for loop 밖에서 생성한 박스 지오메트리와 for loop 안에서 반복 생성한 각각의 퐁-머티리얼을 이용해서 큐브 메쉬를 생성하고, 씬에 각각 추가함
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    idToObject[id] = cube; // {id 색상값: 매칭되는 원래 큐브} 맵핑해줌. 

    // 각 큐브 메쉬의 위치값, 회전값, 크기값을 랜덤으로 할당해 줌
    cube.position.set(random(-20, 20), random(-20, 20), random(-20, 20));
    cube.rotation.set(random(Math.PI), random(Math.PI), 0); // x, y축 방향으로만 랜덤 각도를 리턴받을거임. 이 때 Math.PI는 degree로 변환하면 180도니까 0 ~ 180도 사이의 각도값이 할당되겠지
    cube.scale.set(random(3, 6), random(3, 6), random(3, 6)); // 각 큐브는 width, height, depth 모두 3 ~ 6 사이로 랜덤하게 받으니 정육면체는 아니겠군.

    // 피킹용 씬에 추가해 줄 피킹용 큐브들도 원래 큐브와 동일한 위치값, 회전값, 크기값으로 똑같이 생성해 줌.
    // 다만, 퐁-머티리얼의 고유 색상값만 id 색상값으로 할당해 줌
    const pickingMaterial = new THREE.MeshPhongMaterial({
      emissive: new THREE.Color(id), // 조명의 영향을 받지 않는 strict한 emissive의 색상값으로 id 색상값을 지정해 줌. 
      color: new THREE.Color(0, 0, 0),
      specular: new THREE.Color(0, 0, 0), // color, specular(퐁-머티리얼이 적용된 물체의 하이라이트 부분의 색상값. 기본값은 0x111111)을 black으로 배경색과 동일하게 지정했으므로, 각 큐브의 투명하지 않은 부분(id 색상값이 할당되는 부분)과 구분될거임.
      map: texture, // 원래 큐브와 동일한 구멍 뚫린 텍스처를 할당함
      transparent: true,
      side: THREE.DoubleSide,
      alphaTest: 0.5,
      blending: THREE.NoBlending, // 텍스쳐와 emissive 색상값의 블렌딩(합성)해주지 않게 해서, 텍스쳐의 알파값으로 인해 emissive 색상값이 변하지 않도록 함.
    });
    const pickingCube = new THREE.Mesh(geometry, pickingMaterial);
    pickingScene.add(pickingCube);
    pickingCube.position.copy(cube.position);
    pickingCube.rotation.copy(cube.rotation);
    pickingCube.scale.copy(cube.scale); // Vector2.copy(Vector2) 형태니까, 원래 큐브의 위치값, 회전값, 크기값을 그대로 복사해서 피킹용 큐브에 할당해 줌.
  }

  // resize renderer
  function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
      renderer.setSize(width, height, false);
    }

    return needResize;
  }

  // 헬퍼클래스도 GPUPickingHelper로 변경해서 1*1 렌더타겟에 1*1 카메라로 찍은 마우스 좌표값 바로 아래 피킹용 씬 지점을 렌더하도록 구현함.
  class GPUPickHelper {
    constructor() {
      this.pickingTexture = new THREE.WebGLRenderTarget(1, 1); // 1*1 픽셀 크기의 렌더 타겟 생성
      this.pixelBuffer = new Uint8Array(4); // 픽셀 데이터값(r, g, b, a)을 지정해 줄 4개의 길이를 갖는 형식화배열 생성 
      this.pickedObject = null; // id 색상값이 일치하는 원래 큐브를 할당할거임.
      this.pickedObjectSavedColor = 0; // id 색상값이 일치하는 원래 큐브의 emissive 색상값을 저장해둘거임.
    }

    // GPU 피킹에서는 pick 메서드를 호출할 때 이벤트 좌표값, 피킹용 씬으로 전달할거임.
    pick(cssPosition, scene, camera, time) {
      const {
        pickingTexture,
        pixelBuffer
      } = this; // 생성자의 해당 속성들을 각각의 const에 할당해놓음

      // 기존에 선택된 요소가 있는 경우 emissive 색상값과 pickedObject를 초기화함.
      if (this.pickedObject) {
        this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor);
        this.pickedObject = undefined;
      }

      // camera.setViewOffset을 이용하여 절두체의 렌더러의 width, height을 기준으로 마우스 포인터 아래 1*1 지점으로 view offset을 설정함.
      const pixelRatio = renderer.getPixelRatio(); // 현재 렌더러의 devicePixelRatio 값을 가져옴
      camera.setViewOffset(
        renderer.getContext().drawingBufferWidth, // 현재 렌더러의 드로잉 버퍼 width, 즉, renderer의 width를 전체 너비로 지정
        renderer.getContext().drawingBufferHeight, // 현재 렌더러의 드로잉 버퍼 height, 즉, renderer의 height를 전체 너비로 지정
        cssPosition.x * pixelRatio | 0, // 마우스 이벤트 x좌표값에 pixelRatio를 곱한 뒤(렌더러의 해상도 비율에 따른 위치와 clientX, Y좌표값이 다를수도 있으니까), 비트연산자로 소수점 제거하여 view offset의 x좌표로 지정함.
        cssPosition.y * pixelRatio | 0, // 마우스 이벤트 y좌표값에 pixelRatio를 곱한 뒤, 비트연산자로 소수점 제거하여 view offset의 y좌표로 지정함.
        1,
        1, // view offset의 width, height을 각각 1로 지정해서 전체 너비에서 마우스 이벤트 좌표값 위치의 1 * 1 view offset을 지정함.
      );

      // 렌더러가 활성화할 렌더 대상을 pickingTexture 안에 생성해 놓은 렌더 타겟으로 지정함.
      renderer.setRenderTarget(pickingTexture);
      // 피킹용 씬과 1*1크기의 view offset을 지정한 카메라를 넘겨주면서 렌더 타겟에 매 프레임마다 렌더해줌 
      renderer.render(scene, camera);
      // animate 함수에서 pick 메서드 호출 이후 다시 원래 캔버스를 활성화할 렌더 대상으로 해줘야하기 때문에 null을 전달해주면 원래의 캔버스로 렌더 대상을 초기화함.
      renderer.setRenderTarget(null);

      // clearViewOffset은 setViewOffset에 의해 지정된 어떤 view offset이든 다 제거해버림. 왜? pick 메서드 이후에 다시 원래 캔버스를 찍어주는 카메라로 초기화해서 전달해줘야 하니까!
      camera.clearViewOffset();
      // 전달한 렌더 타겟의 특정 지점(x, y, width, height)의 픽셀데이터를 함께 전달한 Uint8Array 형식화 배열에 복사해 줌.
      renderer.readRenderTargetPixels(
        pickingTexture,
        0, // x
        0, // y
        1, // width
        1, // height 즉, 전달해준 pickingTexture 렌더 타겟이 1*1 사이즈이기 때문에 전체 영역의 픽셀 데이터를 가져오겠다는 뜻이지.
        pixelBuffer
      );

      // Uint8Array에 이진 데이터로 저장된 r, g, b값을 십진수 정수로 바꿔주는 공식. 자세한 원리는 모르겠음ㅠ
      const id = (pixelBuffer[0] << 16) | (pixelBuffer[1] << 8) | (pixelBuffer[2]);

      // Uint8Array의 픽셀데이터로 구한 십진수 정수값과 동일한 key값을 갖는 원래 큐브 메쉬를 광선과 교차한 오브젝트로 할당해 줌.
      const intersectedObject = idToObject[id];
      if (intersectedObject) {
        // 동일한 key값을 갖는 오브젝트가 존재한다면 (존재하지 않는 경우는 const id값이 0인 경우, 즉 'black'일 때겠지?) 해당 오브젝트를 pickedObject에도 넣어줌
        this.pickedObject = intersectedObject;
        // 기존 emissive 색상값을 저장해 둠
        this.pickedObjectSavedColor = this.pickedObject.material.emissive.getHex();
        // emissive 색상값을 빨강/노랑으로 빛나게 만듦.
        this.pickedObject.material.emissive.setHex((time * 8) % 2 > 1 ? 0xFFFF00 : 0xFF0000);
      }
    }
  }

  // pickPosition은 setPickPosition() 함수에 의해 마우스 포인터 좌표값을 정규화한 좌표값 또는 clearPickPosition()에 의해 어떤 물체도 선택할 수 없는 좌표값이 할당될거임.
  const pickPosition = {
    x: 0,
    y: 0
  };
  const pickHelper = new GPUPickHelper(); // 헬퍼 클래스의 인스턴스를 미리 생성해놓음
  clearPickPosition(); // pickPosition의 좌표값을 맨 처음에는 어떤 객체도 선택하지 못하는 좌표값으로 초기화해놓음

  // animate
  function animate(t) {
    t *= 0.001; // 밀리초 단위의 타임스탬프값을 초 단위로 변환

    // 렌더러가 리사이징되면 바뀐 사이즈에 맞춰서 카메라의 비율(aspect)도 업데이트해줌
    if (resizeRendererToDisplaySize(renderer)) {
      const canvas = renderer.domElement;
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
    }

    // 매 프레임마다 카메라의 부모노드인 봉(cameraPole) 객체를 y방향으로 회전시켜 줌
    cameraPole.rotation.y = t * 0.1;

    // 매 프레임마다 pick 메서드를 호출해서 정규화된 좌표값에서 쏜 광선과 가장 먼저 교차하는 물체를 항상 갱신해서 걔의 emissive 색상값을 반짝거리게 해줌.
    pickHelper.pick(pickPosition, pickingScene, camera, t);

    renderer.render(scene, camera);

    requestAnimationFrame(animate); // 내부에서 반복 호출
  }

  requestAnimationFrame(animate);

  // mousemove 이벤트의 좌표값을 캔버스의 상대적 좌표값으로 변환하는 함수
  function getCanvasRelativePosition(e) {
    const rect = canvas.getBoundingClientRect(); // 캔버스 요소의 DOMRect 객체를 리턴받음

    return {
      x: (e.clientX - rect.left) * canvas.width / rect.width,
      y: (e.clientY - rect.top) * canvas.height / rect.height
    }
  }

  // GPU 피킹을 구현할 때는 픽셀을 하나만 사용하므로, 정규화는 안해도 되고, 위치값이 픽셀 하나만 가리키게 변경함.
  function setPickPosition(e) {
    const pos = getCanvasRelativePosition(e);
    pickPosition.x = pos.x;
    pickPosition.y = pos.y;
  }

  function clearPickPosition() {
    pickPosition.x = -100000;
    pickPosition.y = -100000;
  }

  window.addEventListener('mousemove', setPickPosition);
  window.addEventListener('mouseout', clearPickPosition);
  window.addEventListener('mouseleave', clearPickPosition);

  window.addEventListener('touchstart', (e) => {
    e.preventDefault(); // 브라우저에서 정의된 기본 터치 이벤트(스크롤)을 비활성화 함 
    setPickPosition(e.touches[0]); // touchmove의 경우 이벤트의 clientX,Y 좌표값이 담긴 부분이 e.touches[0]인가 봄.
  }, {
    passive: false
  }); // addEventListener에서 passive값을 true로 전달하면 listener가 지정한 콜백함수가 preventDefault를 호출하지 않도록 함. 그럼 false면 당연히 호출하도록 하겠지? 

  window.addEventListener('touchmove', (e) => {
    setPickPosition(e.touches[0]);
  })

  window.addEventListener('touchend',
    clearPickPosition);
}

main();