"""Builds web/template-builtin.pptx: the built-in plain template the site uses until anyone uploads one.

It is made up from nothing but this script: no organisation's name, logo or example content, and the colours are the
site's own (navy text, a magenta accent, light grey rules). It has what the profile builder relies on and nothing more:
widescreen slides (13.33 x 7.5 in), a cover layout named "Title White" (kicker idx 10, title idx 0, subtitle idx 1)
and a content layout named "Spectrum Title Only White" (title at x 0.52 y 0.26, a slide number). No example slides,
no pictures, no printer settings, no thumbnail, and properties with no author: the repository is public.

Run from the repository root (needs python-pptx 1.0.2; not needed by the site or the tests):
    python3 -I scripts/make-builtin-template.py web/template-builtin.pptx
The output is the same every time it is run, so a change to the file shows up as a change to this script.
"""
import datetime
import io
import re
import sys
import zipfile

from lxml import etree
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

OUT = sys.argv[1] if len(sys.argv) > 1 else "template-builtin.pptx"
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
# the site's own palette (web/index.html :root)
NAVY, MAG, GREY, GRID, TILE, BLUE, LBLUE, TEAL, PURPLE, ORANGE = (
    "262166", "EB008C", "666666", "D9DCE6", "EEEEF5", "00539E", "0081C3", "00857C", "944599", "C46A1B")
WHEN = datetime.datetime(2026, 11, 18, 0, 0, 0)


def emu(inches):
    return str(int(round(inches * 914400)))


def xfrm(x, y, w, h):
    return f'<a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>'


def frag(xml):
    return etree.fromstring(f'<p:root {NS}>{xml}</p:root>')[0]


def rect(sid, name, x, y, w, h, fill):
    return frag(
        f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>'
        f'<p:spPr>{xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>')


prs = Presentation()
SCALE = 12192000 / prs.slide_width
prs.slide_width = Emu(12192000)
prs.slide_height = Emu(6858000)
sz = prs.part._element.find(qn("p:sldSz"))
if "type" in sz.attrib:
    del sz.attrib["type"]


def widen(el):
    # the default template is 4:3; stretch every position and width so the inherited placeholders fit 16:9
    for x in el.iter(qn("a:xfrm")):
        off, ext = x.find(qn("a:off")), x.find(qn("a:ext"))
        if off is not None:
            off.set("x", str(int(int(off.get("x")) * SCALE)))
        if ext is not None:
            ext.set("cx", str(int(int(ext.get("cx")) * SCALE)))


master = prs.slide_master
widen(master._element)

# The theme: named "Plain", Arial throughout, the site's colours
theme = master.part.part_related_by("http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme")
tx = etree.fromstring(theme.blob)
tx.set("name", "Plain")
scheme = tx.find(".//" + qn("a:clrScheme"))
scheme.set("name", "Plain")
colours = {"dk1": NAVY, "lt1": "FFFFFF", "dk2": NAVY, "lt2": TILE, "accent1": NAVY, "accent2": LBLUE, "accent3": TEAL,
           "accent4": PURPLE, "accent5": ORANGE, "accent6": MAG, "hlink": BLUE, "folHlink": PURPLE}
for name, val in colours.items():
    el = scheme.find(qn("a:" + name))
    for c in list(el):
        el.remove(c)
    etree.SubElement(el, qn("a:srgbClr")).set("val", val)
tx.find(".//" + qn("a:fontScheme")).set("name", "Plain")
for font in ("a:majorFont", "a:minorFont"):
    f = tx.find(".//" + qn(font))
    f.find(qn("a:latin")).set("typeface", "Arial")
    for c in f.findall(qn("a:font")):   # no per-script fonts: Arial everywhere
        f.remove(c)
theme._blob = etree.tostring(tx, xml_declaration=True, encoding="UTF-8", standalone=True)

# The master keeps its title, text and slide number; its date and footer boxes (with the default's example date) go
for sp in list(master.placeholders):
    if sp.placeholder_format.type is not None and int(sp.placeholder_format.type) in (16, 15):   # date, footer
        sp._element.getparent().remove(sp._element)

# Two layouts only
keep = {"Title Slide": "Title White", "Title Only": "Spectrum Title Only White"}
for layout in list(prs.slide_layouts):
    if layout.name not in keep:
        prs.slide_layouts.remove(layout)
for layout in prs.slide_layouts:
    widen(layout._element)
    layout._element.cSld.set("name", keep[layout.name])


def ph_sp(layout, idx):
    for sp in layout.placeholders:
        if sp.placeholder_format.idx == idx:
            return sp._element
    return None


def restyle(sp, x, y, w, h, size, color, bold=False, align="l", anchor="t", caps=False, spc=0):
    spPr = sp.find(qn("p:spPr"))
    for c in list(spPr):
        spPr.remove(c)
    spPr.append(frag(xfrm(x, y, w, h)))
    body = sp.find(qn("p:txBody"))
    bp = body.find(qn("a:bodyPr"))
    bp.set("anchor", anchor)
    for k in ("lIns", "rIns", "tIns", "bIns"):
        bp.set(k, "0")
    for c in list(bp):
        bp.remove(c)
    etree.SubElement(bp, qn("a:normAutofit"))
    lst = body.find(qn("a:lstStyle"))
    for c in list(lst):
        lst.remove(c)
    extra = (' cap="all"' if caps else "") + (f' spc="{spc}"' if spc else "")
    lst.append(frag(f'<a:lvl1pPr marL="0" indent="0" algn="{align}"><a:buNone/><a:defRPr sz="{size * 100}" b="{1 if bold else 0}"{extra}>'
                    f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr>'))


def prompt(sp, text):
    body = sp.find(qn("p:txBody"))
    for p in body.findall(qn("a:p")):
        body.remove(p)
    body.append(frag(f'<a:p><a:r><a:rPr lang="en-US"/><a:t>{text}</a:t></a:r></a:p>'))


# Cover, "Title White": a magenta accent, the kicker, a large navy title, a grey subtitle, a navy band at the foot.
cover = [l for l in prs.slide_layouts if l.name == "Title White"][0]
k = ph_sp(cover, 10)
k.find(qn("p:nvSpPr")).find(qn("p:cNvPr")).set("name", "Kicker")
ph = k.find(qn("p:nvSpPr")).find(qn("p:nvPr")).find(qn("p:ph"))
ph.set("type", "body")
ph.attrib.pop("sz", None)
prompt(k, "Kicker")
restyle(k, 0.9, 2.3, 11.5, 0.4, 14, MAG, bold=True, caps=True, spc=100, anchor="b")
restyle(ph_sp(cover, 0), 0.9, 2.8, 11.5, 1.5, 40, NAVY, bold=True, anchor="b")
prompt(ph_sp(cover, 0), "Title")
restyle(ph_sp(cover, 1), 0.9, 4.45, 11.5, 0.6, 18, GREY)
prompt(ph_sp(cover, 1), "Subtitle")
for idx in (11, 12):
    sp = ph_sp(cover, idx)
    sp.getparent().remove(sp)
ctree = cover._element.cSld.spTree
ctree.append(rect(20, "Accent", 0.9, 2.0, 0.9, 0.08, MAG))
ctree.append(rect(21, "Rule", 0.9, 5.25, 11.5, 0.02, GRID))
ctree.append(rect(22, "Band", 0, 7.1, 13.333, 0.4, NAVY))

# Content, "Spectrum Title Only White": a thin navy bar at the top, the title at 0.52, 0.26, a grey rule and the slide
# number at the foot. The space between is left for the builder (its section headers start at y 1.3).
content = [l for l in prs.slide_layouts if l.name == "Spectrum Title Only White"][0]
restyle(ph_sp(content, 0), 0.52, 0.26, 12.28, 1.02, 26, NAVY, bold=True, anchor="ctr")
prompt(ph_sp(content, 0), "Title")
for idx in (10, 11):
    sp = ph_sp(content, idx)
    sp.getparent().remove(sp)
restyle(ph_sp(content, 12), 12.2, 7.06, 0.6, 0.26, 10, GREY, align="r", anchor="ctr")
tree = content._element.cSld.spTree
tree.insert(2, rect(20, "Top bar", 0, 0, 13.333, 0.08, NAVY))
tree.append(rect(22, "Foot rule", 0.52, 7.0, 12.28, 0.01, GRID))

# The properties: a plain title, no author, a fixed date (so the file is the same each time)
cp = prs.core_properties
cp.title = "Plain template"
cp.author = ""
cp.last_modified_by = ""
cp.comments = ""
cp.subject = ""
cp.keywords = ""
cp.category = ""
cp.revision = 1
cp.created = WHEN
cp.modified = WHEN

# No printer settings (the default carries some)
for rid, rel in list(prs.part.rels.items()):
    if rel.reltype.endswith("/printerSettings"):
        prs.part.drop_rel(rid)

buf = io.BytesIO()
prs.save(buf)

APP = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
       '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
       'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
       '<TotalTime>0</TotalTime><Words>0</Words><Application>Microsoft Office PowerPoint</Application>'
       '<PresentationFormat>Widescreen</PresentationFormat><Paragraphs>0</Paragraphs><Slides>0</Slides><Notes>0</Notes>'
       '<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>'
       '<HeadingPairs><vt:vector size="4" baseType="variant">'
       '<vt:variant><vt:lpstr>Fonts Used</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '</vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="2" baseType="lpstr">'
       '<vt:lpstr>Arial</vt:lpstr><vt:lpstr>Plain</vt:lpstr></vt:vector></TitlesOfParts>'
       '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
       '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>')

src = zipfile.ZipFile(buf)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as out:
    for item in src.infolist():
        name = item.filename
        if name.startswith("docProps/thumbnail") or name.startswith("ppt/printerSettings/"):
            continue
        data = src.read(name)
        if name == "docProps/app.xml":
            data = APP.encode("utf-8")
        elif name == "_rels/.rels":   # the thumbnail goes
            data = re.sub(rb'<Relationship [^>]*thumbnail[^>]*/>', b"", data)
        elif name == "[Content_Types].xml":
            data = re.sub(rb'<(Default|Override) [^>]*(jpeg|printerSettings)[^>]*/>', b"", data)
        elif name == "docProps/core.xml":   # no print date, should the default ever carry one
            data = re.sub(rb"<cp:lastPrinted>[^<]*</cp:lastPrinted>", b"", data)
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 18, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        out.writestr(info, data)
print("wrote", OUT)
