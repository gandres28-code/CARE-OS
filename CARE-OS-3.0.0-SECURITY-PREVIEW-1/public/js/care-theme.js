(()=>{
  "use strict";
  const normalizedPath=(location.pathname||"/").replace(/\/$/,"")||"/";
  const isExecutiveWall=/\/dashboard(?:\.html)?$/i.test(normalizedPath);
  const KEY=`careTheme:${normalizedPath}`;
  const saved=localStorage.getItem(KEY);
  let theme=saved==="dark"||saved==="light"?saved:(isExecutiveWall?"dark":"light");
  function apply(next){
    theme=next;
    document.documentElement.dataset.careTheme=theme;
    document.documentElement.dataset.theme=theme;
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.content=theme==="dark"?"#07111f":"#f4f7fb";
    window.dispatchEvent(new CustomEvent("care:theme",{detail:{theme}}));
  }
  apply(theme);
  document.addEventListener("DOMContentLoaded",()=>{
    if(!document.getElementById("careThemeToggle")){
      const button=document.createElement("button");
      button.id="careThemeToggle";
      button.className="care-theme-toggle";
      button.type="button";
      button.setAttribute("aria-label","Cambiar tema de esta pantalla");
      button.onclick=()=>setTheme(theme==="dark"?"light":"dark");
      document.body.appendChild(button);
    }
    apply(theme);
  });
  function setTheme(next){
    if(next!=="dark"&&next!=="light")return;
    localStorage.setItem(KEY,next);
    apply(next);
  }
  window.addEventListener("storage",event=>{if(event.key===KEY&&(event.newValue==="dark"||event.newValue==="light"))apply(event.newValue)});
  window.CARETheme={get:()=>theme,set:setTheme,key:KEY};
})();
