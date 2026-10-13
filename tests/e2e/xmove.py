# Mueve el puntero real del servidor X (XTest) a x, y: genera eventos de mouse
# verdaderos, con coordenadas de pantalla reales (los de Playwright no las traen).
# Requiere python-xlib.  Uso: python3 xmove.py X Y
import sys

from Xlib import X, display
from Xlib.ext import xtest

d = display.Display()
xtest.fake_input(d, X.MotionNotify, x=int(sys.argv[1]), y=int(sys.argv[2]))
d.sync()
