(()=>{
  "use strict";
  const isExecutiveWall=/\/dashboard\.html$/i.test(location.pathname);
  let theme=isExecutiveWall?"dark":"light";
  function apply(next){
    theme=next;
    document.documentElement.dataset.careTheme=theme;
    document.documentElement.dataset.theme=theme;
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.content=theme==="dark"?"#07111f":"#f4f7fb";
    window.dispatchEvent(new CustomEvent("care:theme",{detail:{theme}}));
  }
  apply(theme);
  document.addEventListener("DOMContentLoaded",()=>apply(theme));
  window.CARETheme={get:()=>theme};
})();
