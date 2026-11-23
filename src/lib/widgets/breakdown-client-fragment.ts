/** Lightweight visualization of the product-ui DonutChart and 100% breakdown.
 * Public embeds are script-only, so use the same chart tokens without React.
 */
export const BREAKDOWN_CLIENT_FRAGMENT = String.raw`
  function breakdownColor(i, count) { return paletteColor(i, count); }
  function breakdownRows(data) {
    var rows = (Array.isArray(data.rows) ? data.rows : []).filter(function(row) {
      return row && typeof row.label === "string" && Number.isFinite(row.value) && row.value >= 0;
    }).slice(0, Number(root.dataset.limit)||10);
    return { rows: rows, total: rows.reduce(function(sum,r) {return sum+r.value;},0) };
  }
  function breakdownLegend(data) {
    var ul=document.createElement("ul");ul.className="widget__breakdown-legend";
    data.rows.forEach(function(row,i) {
      var li=document.createElement("li");li.className="widget__breakdown-row";
      var label=document.createElement("span");label.className="widget__breakdown-name";
      var swatch=document.createElement("span");swatch.className="widget__breakdown-swatch";
      swatch.style.background=breakdownColor(i,data.rows.length);
      var name=document.createElement("span");name.textContent=row.label;name.title=row.label;
      label.append(swatch,name);
      var percent=document.createElement("span");percent.className="widget__breakdown-value";
      percent.textContent=new Intl.NumberFormat(localeTag(),{style:"percent",maximumFractionDigits:1})
        .format(data.total>0?row.value/data.total:0);
      percent.title=formatNumber(row.value);
      li.append(label,percent);ul.appendChild(li);
    });
    return ul;
  }
  function renderDonut(data) {
    var d=breakdownRows(data);
    if (!d.rows.length||d.total<=0) {setStatus(messages.noData);return;}
    var wrap=document.createElement("div");wrap.className="widget__donut-wrap";
    var svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 140 140");svg.setAttribute("class","widget__donut-ring");
    svg.setAttribute("role","img");svg.setAttribute("aria-label",messages.categoryShare);
    var r=53,c=2*Math.PI*r,offset=0;
    var bg=document.createElementNS(svg.namespaceURI,"circle");
    bg.setAttribute("cx","70");bg.setAttribute("cy","70");bg.setAttribute("r",String(r));
    bg.setAttribute("fill","none");bg.setAttribute("stroke","var(--muted)");bg.setAttribute("stroke-width","20");
    svg.appendChild(bg);
    d.rows.forEach(function(row,i) {
      var portion=row.value/d.total;if(portion<=0)return;
      var arc=document.createElementNS(svg.namespaceURI,"circle");
      arc.setAttribute("cx","70");arc.setAttribute("cy","70");arc.setAttribute("r",String(r));
      arc.setAttribute("fill","none");arc.setAttribute("stroke",breakdownColor(i,d.rows.length));
      arc.setAttribute("stroke-width","20");
      arc.setAttribute("stroke-dasharray",String(portion*c)+" "+String(c));
      arc.setAttribute("stroke-dashoffset",String(-offset*c));
      arc.setAttribute("transform","rotate(-90 70 70)");
      var tip=document.createElementNS(svg.namespaceURI,"title");
      tip.textContent=row.label+" · "+formatNumber(row.value)+" · "+
        new Intl.NumberFormat(localeTag(),{style:"percent",maximumFractionDigits:1}).format(portion);
      arc.appendChild(tip);svg.appendChild(arc);offset+=portion;
    });
    var center=document.createElementNS(svg.namespaceURI,"text");
    center.setAttribute("x","70");center.setAttribute("y","71");center.setAttribute("text-anchor","middle");
    center.setAttribute("class","widget__donut-total");center.textContent=formatNumber(d.total);
    var caption=document.createElementNS(svg.namespaceURI,"text");
    caption.setAttribute("x","70");caption.setAttribute("y","87");caption.setAttribute("text-anchor","middle");
    caption.setAttribute("class","widget__donut-caption");caption.textContent=metricLabel[data.metric]||"";
    svg.append(center,caption);
    wrap.append(svg,breakdownLegend(d));content.appendChild(wrap);
  }
  function renderRatio(data) {
    var d=breakdownRows(data);
    if(!d.rows.length||d.total<=0) {setStatus(messages.noData);return;}
    var wrap=document.createElement("div");wrap.className="widget__ratio-layout";
    var track=document.createElement("div");track.className="widget__ratio-track";
    track.setAttribute("role","img");track.setAttribute("aria-label",messages.categoryShare);
    d.rows.forEach(function(row,i) {
      var segment=document.createElement("span");segment.className="widget__ratio-segment";
      segment.style.width=(100*row.value/d.total)+"%";
      segment.style.background=breakdownColor(i,d.rows.length);
      segment.title=row.label+" · "+formatNumber(row.value);
      track.appendChild(segment);
    });
    wrap.append(track,breakdownLegend(d));content.appendChild(wrap);
  }
`;
