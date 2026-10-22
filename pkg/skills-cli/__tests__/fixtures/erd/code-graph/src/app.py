from .helpers import util
import os


def run():
    return util() or os.getcwd()
