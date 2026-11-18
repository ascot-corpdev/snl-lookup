"""Builds web/standard-template.pptx: the plain, unbranded PowerPoint template that ships with the site.

The Profile view builds on this template when no team or personal template has been uploaded, so a profile can be
built straight after set-up. The repository is public, so the template carries no company name, logo, picture or
house colours: white slides, dark grey Arial text, a thin grey rule and a slide number. It has no slides of its own.

What the profile builder (web/deck.js) needs from it:
- 13.33 x 7.5 in (widescreen 16:9)
- "Title White": the cover. A kicker line (body placeholder, idx 10), a title (idx 0) and a subtitle (idx 1).
- "Spectrum Title Only White": every other slide. A title at x 0.52 y 0.26 and a slide number. The content area
  below the title (y 1.3 to 6.96) is left empty for the builder.
Three more layouts ("Title and Content", "Section Header", "Blank") make it an ordinary template to work in.

Run from the repository root to regenerate it (needs python-pptx 1.0.2; not needed by the site or the tests):
    python3 -I scripts/make-standard-template.py web/standard-template.pptx
The output is the same every run (fixed dates and zip times), so a regenerated file only shows as changed in git
when this script changes.
"""
import datetime
import io
import sys
import zipfile

from lxml import etree
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

OUT = sys.argv[1] if len(sys.argv) > 1 else "standard-template.pptx"
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
INK, MUTED, RULE, BAND = "1F2937", "6B7280", "D1D5DB", "F3F4F6"
FIXED = datetime.datetime(2026, 1, 1, 0, 0, 0)


def emu(inches):
    return str(int(round(inches * 914400)))


def xfrm(x, y, w, h):
    return f'<a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>'


def frag(xml):
    return etree.fromstring(f'<p:root {NS}>{xml}</p:root>')[0]


prs = Presentation()
SCALE = 12192000 / prs.slide_width
prs.slide_width = Emu(12192000)
prs.slide_height = Emu(6858000)
sz = prs.part._element.find(qn("p:sldSz"))
if "type" in sz.attrib:
    del sz.attrib["type"]

# nothing that names a person or a tool in the file's properties
cp = prs.core_properties
cp.title, cp.subject, cp.author, cp.keywords, cp.comments, cp.category = "Standard template", "", "", "", "", ""
cp.last_modified_by, cp.revision = "", 1
cp.created = cp.modified = FIXED


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

# ---------- the theme: neutral colours, Arial throughout ----------
theme = master.part.part_related_by(RT + "theme")
tx = etree.fromstring(theme.blob)
tx.set("name", "Standard")
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
scheme = tx.find(f".//{A}clrScheme")
scheme.set("name", "Standard")
COLOURS = {"dk1": "000000", "lt1": "FFFFFF", "dk2": INK, "lt2": BAND, "accent1": "1F4E79", "accent2": "6B7280",
           "accent3": "2E7D6B", "accent4": "B45309", "accent5": "4B5563", "accent6": "9CA3AF", "hlink": "1F4E79", "folHlink": "6B7280"}
for name, val in COLOURS.items():
    slot = scheme.find(A + name)
    for c in list(slot):
        slot.remove(c)
    etree.SubElement(slot, A + "srgbClr").set("val", val)
fonts = tx.find(f".//{A}fontScheme")
fonts.set("name", "Standard")
for font in ("majorFont", "minorFont"):
    fonts.find(A + font).find(A + "latin").set("typeface", "Arial")
tx.find(f".//{A}fmtScheme").set("name", "Standard")
theme._blob = etree.tostring(tx, xml_declaration=True, encoding="UTF-8", standalone=True)

# Master text in dark grey rather than black
for path in (".//p:titleStyle//a:defRPr", ".//p:bodyStyle//a:defRPr"):
    for r in master._element.findall(path, {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "a": A[1:-1]}):
        for c in r.findall(A + "solidFill"):
            r.remove(c)
        r.insert(0, frag(f'<a:solidFill><a:srgbClr val="{INK}"/></a:solidFill>'))

# ---------- the layouts ----------
keep = {"Title Slide": "Title White", "Title and Content": "Title and Content", "Section Header": "Section Header",
        "Title Only": "Spectrum Title Only White", "Blank": "Blank"}
for layout in list(prs.slide_layouts):
    if layout.name not in keep:
        prs.slide_layouts.remove(layout)
for layout in prs.slide_layouts:
    widen(layout._element)
    layout._element.cSld.set("name", keep[layout.name])


def by_name(name):
    return [l for l in prs.slide_layouts if l.name == name][0]


def ph_sp(layout, idx):
    for sp in layout.placeholders:
        if sp.placeholder_format.idx == idx:
            return sp._element
    return None


def drop(layout, *idxs):
    for idx in idxs:
        sp = ph_sp(layout, idx)
        if sp is not None:
            sp.getparent().remove(sp)


def restyle(sp, x, y, w, h, size, color, bold=False, align="l", anchor="t"):
    spPr = sp.find(qn("p:spPr"))
    for c in list(spPr):
        spPr.remove(c)
    spPr.append(frag(xfrm(x, y, w, h)))
    body = sp.find(qn("p:txBody"))
    body.find(qn("a:bodyPr")).set("anchor", anchor)
    lst = body.find(qn("a:lstStyle"))
    for c in list(lst):
        lst.remove(c)
    lst.append(frag(f'<a:lvl1pPr marL="0" indent="0" algn="{align}"><a:buNone/><a:defRPr sz="{size * 100}" b="{1 if bold else 0}">'
                    f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr>'))


def rect(sid, name, x, y, w, h, fill):
    return frag(f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>'
                f'<p:spPr>{xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
                f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>')


def rule(sid, name, x, y, w):
    return frag(f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvCxnSpPr/><p:nvPr userDrawn="1"/></p:nvCxnSpPr>'
                f'<p:spPr>{xfrm(x, y, w, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
                f'<a:ln w="9525"><a:solidFill><a:srgbClr val="{RULE}"/></a:solidFill></a:ln></p:spPr></p:cxnSp>')


# Cover, "Title White": the date placeholder (idx 10) becomes the kicker line; footer and number go.
cover = by_name("Title White")
k = ph_sp(cover, 10)
k.find(qn("p:nvSpPr")).find(qn("p:cNvPr")).set("name", "Kicker 3")
ph = k.find(qn("p:nvSpPr")).find(qn("p:nvPr")).find(qn("p:ph"))
ph.set("type", "body")
if "sz" in ph.attrib:
    del ph.attrib["sz"]
body = k.find(qn("p:txBody"))
for p in body.findall(qn("a:p")):
    body.remove(p)
body.append(frag('<a:p><a:r><a:rPr lang="en-US"/><a:t>Kicker</a:t></a:r></a:p>'))
restyle(k, 0.9, 2.2, 11.5, 0.45, 16, MUTED, bold=True)
restyle(ph_sp(cover, 0), 0.9, 2.75, 11.5, 1.3, 40, INK, bold=True, anchor="b")
restyle(ph_sp(cover, 1), 0.9, 4.2, 11.5, 0.6, 20, MUTED)
drop(cover, 11, 12)
tree = cover._element.cSld.spTree
tree.append(rule(20, "Cover rule", 1.0, 4.12, 11.3))   # in line with the text, inside its 0.1 in margin
tree.append(rect(21, "Cover band", 0, 7.1, 13.333, 0.4, BAND))

# Content, "Spectrum Title Only White": the title at 0.52, 0.26; a thin rule under it; the slide number.
content = by_name("Spectrum Title Only White")
restyle(ph_sp(content, 0), 0.52, 0.26, 12.28, 0.86, 28, INK, bold=True, anchor="ctr")
drop(content, 10, 11)
restyle(ph_sp(content, 12), 12.2, 7.02, 0.6, 0.3, 10, MUTED, align="r", anchor="ctr")
content._element.cSld.spTree.append(rule(20, "Title rule", 0.52, 1.17, 12.28))

# The other layouts: Arial, dark grey, no date or footer boxes
for name in ("Title and Content", "Section Header"):
    lay = by_name(name)
    drop(lay, 10, 11)
    restyle(ph_sp(lay, 12), 12.2, 7.02, 0.6, 0.3, 10, MUTED, align="r", anchor="ctr")
lay = by_name("Title and Content")
restyle(ph_sp(lay, 0), 0.52, 0.26, 12.28, 0.86, 28, INK, bold=True, anchor="ctr")
lay._element.cSld.spTree.append(rule(20, "Title rule", 0.52, 1.17, 12.28))
lay = by_name("Section Header")
restyle(ph_sp(lay, 0), 0.9, 2.6, 11.5, 1.3, 36, INK, bold=True, anchor="b")
restyle(ph_sp(lay, 1), 0.9, 4.05, 11.5, 0.8, 18, MUTED)
drop(by_name("Blank"), 10, 11, 12)

buf = io.BytesIO()
prs.save(buf)

# ---------- the package, tidied ----------
# No thumbnail picture or printer settings; docProps/app.xml as PowerPoint writes it for an empty widescreen file.
APP = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
       '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
       'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
       '<TotalTime>0</TotalTime><Words>0</Words><Application>Microsoft Office PowerPoint</Application>'
       '<PresentationFormat>Widescreen</PresentationFormat><Paragraphs>0</Paragraphs><Slides>0</Slides><Notes>0</Notes>'
       '<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>'
       '<HeadingPairs><vt:vector size="6" baseType="variant">'
       '<vt:variant><vt:lpstr>Fonts Used</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '<vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant><vt:variant><vt:i4>0</vt:i4></vt:variant>'
       '</vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="2" baseType="lpstr">'
       '<vt:lpstr>Arial</vt:lpstr><vt:lpstr>Standard</vt:lpstr>'
       '</vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
       '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>')
DROP = {"docProps/thumbnail.jpeg", "ppt/printerSettings/printerSettings1.bin"}


def without_rels(xml, targets):
    root = etree.fromstring(xml)
    for r in list(root):
        if r.get("Target") in targets:
            root.remove(r)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


src = zipfile.ZipFile(buf)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as out:
    for item in src.infolist():
        name = item.filename
        if name in DROP:
            continue
        data = src.read(name)
        if name == "docProps/app.xml":
            data = APP.encode("utf-8")
        elif name == "_rels/.rels":
            data = without_rels(data, {"docProps/thumbnail.jpeg"})
        elif name == "ppt/_rels/presentation.xml.rels":
            data = without_rels(data, {"printerSettings/printerSettings1.bin"})
        elif name == "[Content_Types].xml":
            root = etree.fromstring(data)
            for d in list(root):
                if d.get("Extension") in ("bin", "jpeg"):
                    root.remove(d)
            data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        info = zipfile.ZipInfo(name, date_time=FIXED.timetuple()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        out.writestr(info, data)
print("wrote", OUT)
