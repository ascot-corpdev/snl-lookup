"""Builds tests/fixtures/standin-template.pptx: a made-up stand-in for the team's PowerPoint template.

The real template is private and never in this repository. This stand-in has what the profile builder relies on:
13.33 x 7.5 in; a cover layout named "Title White" (kicker idx 10, title idx 0, descriptor idx 1); a content layout
named "Spectrum Title Only White" (title at x 0.52 y 0.26, a colour stripe, a static footer, a slide number
placeholder); a few other layouts; and three example slides (one with notes, one with pictures, one with a chart)
in a section, so the builder's removal of example slides is really tested. A picture is shared between an example
slide and a layout, so removal must keep it.

Run from the repository root (needs python-pptx 1.0.2 and Pillow; not needed by the tests themselves):
    python3 -I tests/fixtures/make-standin-template.py tests/fixtures/standin-template.pptx
"""
import io
import sys
import zipfile

from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches

OUT = sys.argv[1] if len(sys.argv) > 1 else "standin-template.pptx"
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
NAVY, MAG, GREY = "262166", "EB008C", "666666"


def emu(inches):
    return str(int(round(inches * 914400)))


def xfrm(x, y, w, h):
    return f'<a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>'


def frag(xml):
    return etree.fromstring(f'<p:root {NS}>{xml}</p:root>')[0]


def png(color, size):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    buf.seek(0)
    return buf


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

# Arial throughout: point the theme's fonts at Arial
theme = master.part.part_related_by("http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme")
tx = etree.fromstring(theme.blob)
for font in ("a:majorFont", "a:minorFont"):
    tx.find(".//" + qn(font)).find(qn("a:latin")).set("typeface", "Arial")
theme._blob = etree.tostring(tx, xml_declaration=True, encoding="UTF-8", standalone=True)

keep = {"Title Slide": "Title White", "Title and Content": "Title and Content", "Section Header": "Section Header",
        "Title Only": "Spectrum Title Only White", "Blank": "Blank"}
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


# Cover: "Title White". The date placeholder (idx 10) becomes the kicker line; footer and number go.
cover = [l for l in prs.slide_layouts if l.name == "Title White"][0]
k = ph_sp(cover, 10)
k.find(qn("p:nvSpPr")).find(qn("p:cNvPr")).set("name", "Kicker 3")
ph = k.find(qn("p:nvSpPr")).find(qn("p:nvPr")).find(qn("p:ph"))
ph.set("type", "body")
del ph.attrib["sz"]
body = k.find(qn("p:txBody"))
for p in body.findall(qn("a:p")):
    body.remove(p)
body.append(frag('<a:p><a:r><a:rPr lang="en-GB"/><a:t>Kicker</a:t></a:r></a:p>'))
restyle(k, 0.9, 2.2, 11.5, 0.45, 16, MAG, bold=True)
restyle(ph_sp(cover, 0), 0.9, 2.75, 11.5, 1.3, 40, NAVY, bold=True, anchor="b")
restyle(ph_sp(cover, 1), 0.9, 4.2, 11.5, 0.6, 20, NAVY)
for idx in (11, 12):
    sp = ph_sp(cover, idx)
    sp.getparent().remove(sp)
cover._element.cSld.spTree.append(frag(
    '<p:sp><p:nvSpPr><p:cNvPr id="20" name="Cover band"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>'
    f'<p:spPr>{xfrm(0, 6.9, 13.333, 0.6)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    f'<a:solidFill><a:srgbClr val="{NAVY}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>'))

# Content: "Spectrum Title Only White". Title at 0.52, 0.26; a colour stripe; a static footer; the slide number.
content = [l for l in prs.slide_layouts if l.name == "Spectrum Title Only White"][0]
restyle(ph_sp(content, 0), 0.52, 0.26, 12.28, 1.02, 28, MAG, anchor="ctr")
for idx in (10, 11):
    sp = ph_sp(content, idx)
    sp.getparent().remove(sp)
restyle(ph_sp(content, 12), 12.2, 7.02, 0.6, 0.3, 10, GREY, align="r", anchor="ctr")
tree = content._element.cSld.spTree
tree.insert(2, frag(
    '<p:sp><p:nvSpPr><p:cNvPr id="20" name="Colour stripe"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>'
    f'<p:spPr>{xfrm(0, 0, 0.18, 7.5)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    f'<a:solidFill><a:srgbClr val="{MAG}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>'))
tree.append(frag(
    '<p:sp><p:nvSpPr><p:cNvPr id="21" name="Footer text"/><p:cNvSpPr txBox="1"/><p:nvPr userDrawn="1"/></p:nvSpPr>'
    f'<p:spPr>{xfrm(0.52, 7.02, 5, 0.3)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/>'
    f'<a:p><a:r><a:rPr lang="en-GB" sz="900"><a:solidFill><a:srgbClr val="{GREY}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr>'
    '<a:t>Stand-in template footer</a:t></a:r></a:p></p:txBody></p:sp>'))

# A small mark on the "Blank" layout that shares its picture with an example slide
mark = png((38, 33, 102), (40, 20))
blank = [l for l in prs.slide_layouts if l.name == "Blank"][0]
_, rid = blank.part.get_or_add_image_part(mark)
blank._element.cSld.spTree.append(frag(
    '<p:pic><p:nvPicPr><p:cNvPr id="30" name="Mark"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr>'
    f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
    f'<p:spPr>{xfrm(12.2, 0.3, 0.6, 0.3)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'))

# Three example slides
s1 = prs.slides.add_slide([l for l in prs.slide_layouts if l.name == "Title and Content"][0])
s1.shapes.title.text = "Example slide"
s1.placeholders[1].text = "Example text"
s1.notes_slide.notes_text_frame.text = "Example notes"

s2 = prs.slides.add_slide(content)
s2.shapes.title.text = "Example slide with a picture"
mark.seek(0)
s2.shapes.add_picture(mark, Inches(1), Inches(2), Inches(2), Inches(1))
s2.shapes.add_picture(png((235, 0, 140), (60, 30)), Inches(4), Inches(2), Inches(4), Inches(2))

s3 = prs.slides.add_slide(content)
s3.shapes.title.text = "Example slide with a chart"
cd = CategoryChartData()
cd.categories = ["2023", "2024", "2025"]
cd.add_series("Example series", (1.0, 2.0, 3.0))
s3.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.5), Inches(6), Inches(4), cd)

# The example slides sit in one section, as a real template's do
pres = prs.part._element
ext_lst = pres.find(qn("p:extLst"))
if ext_lst is None:
    ext_lst = etree.SubElement(pres, qn("p:extLst"))
ids = "".join(f'<p14:sldId id="{s.get("id")}"/>' for s in pres.find(qn("p:sldIdLst")))
ext_lst.append(etree.fromstring(
    '<p:ext xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">'
    '<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">'
    f'<p14:section name="Examples" id="{{6A1E2B3C-0D4F-4A5B-8C6D-7E8F9A0B1C2D}}"><p14:sldIdLst>{ids}</p14:sldIdLst></p14:section>'
    '</p14:sectionLst></p:ext>'))

buf = io.BytesIO()
prs.save(buf)

# docProps/app.xml as PowerPoint writes it: fonts, theme and slide titles, with counts
APP = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
       '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
       'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
       '<TotalTime>0</TotalTime><Words>12</Words><Application>Microsoft Office PowerPoint</Application>'
       '<PresentationFormat>Widescreen</PresentationFormat><Paragraphs>5</Paragraphs><Slides>3</Slides><Notes>1</Notes>'
       '<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>'
       '<HeadingPairs><vt:vector size="6" baseType="variant">'
       '<vt:variant><vt:lpstr>Fonts Used</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>'
       '<vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant>'
       '</vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="5" baseType="lpstr">'
       '<vt:lpstr>Arial</vt:lpstr><vt:lpstr>Office Theme</vt:lpstr><vt:lpstr>Example slide</vt:lpstr>'
       '<vt:lpstr>Example slide with a picture</vt:lpstr><vt:lpstr>Example slide with a chart</vt:lpstr>'
       '</vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
       '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>')

src = zipfile.ZipFile(buf)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as out:
    for item in src.infolist():
        data = APP.encode("utf-8") if item.filename == "docProps/app.xml" else src.read(item.filename)
        out.writestr(item.filename, data)
print("wrote", OUT)
