(()=>{
  "use strict";
  const KEY="careTheme";
  const systemDark=()=>window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
  const saved=localStorage.getItem(KEY);
  let theme=saved==="dark"||saved==="light"?saved:(systemDark()?"dark":"light");
  function apply(next){
    theme=next;
    document.documentElement.dataset.careTheme=theme;
    document.documentElement.dataset.theme=theme;
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.content=theme==="dark"?"#07111f":"#f4f7fb";
    const button=document.getElementById("careThemeToggle");
    if(button){button.textContent=theme==="dark"?"Tema claro":"Tema oscuro";button.setAttribute("aria-pressed",String(theme==="dark"));}
    window.dispatchEvent(new CustomEvent("care:theme",{detail:{theme}}));
  }
  apply(theme);
  document.addEventListener("DOMContentLoaded",()=>{
    if(document.getElementById("careThemeToggle"))return;
    const button=document.createElement("button");
    button.id="careThemeToggle";button.className="care-theme-toggle";button.type="button";
    button.setAttribute("aria-label","Cambiar tema de C.A.R.E");
    button.onclick=()=>{const next=theme==="dark"?"light":"dark";localStorage.setItem(KEY,next);apply(next)};
    document.body.appendChild(button);apply(theme);
  });
  window.addEventListener("storage",event=>{if(event.key===KEY&&(event.newValue==="dark"||event.newValue==="light"))apply(event.newValue)});
  window.CARETheme={get:()=>theme,set:(next)=>{if(next!=="dark"&&next!=="light")return;localStorage.setItem(KEY,next);apply(next)}};
})();
